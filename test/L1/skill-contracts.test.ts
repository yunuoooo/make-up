import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * 技能文本的契约守卫。
 *
 * 上游的技能包比仓库版本新，而且**它删掉了 `looktrace-products` 机器可读商品块**——
 * 那是 `lib/commerce/product-block.ts` 的唯一输入，删了不报错，只是商品卡片从此
 * 静默消失。同类静默丢失还有：把「色号待试」改成给绝对色号、把 `xhs_*` 工具换回
 * `node scripts/*.mjs`、以及把「不要自己拼链接」改回「附链接」。
 *
 * 所以这里把这几条**钉在文本上**：上游下一次升级同样会动它们，我们要的是测试失败，
 * 而不是线上少一块卡片。
 */

const ROOT = process.cwd();
const ADVISOR_DIR = join(ROOT, "xiaohongshu-makeup-advisor-latest");
const KIT_DIR = join(ROOT, "makeup-kit");

async function readSkillFile(dir: string, relative: string): Promise<string> {
  return readFile(join(dir, relative), "utf8");
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

const SKILL_DIRS = [ADVISOR_DIR, KIT_DIR];

test("两个技能的入口文件都在，frontmatter 能被 pi 解析", async () => {
  for (const dir of SKILL_DIRS) {
    const body = await readSkillFile(dir, "SKILL.md");
    const frontmatter = body.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, `${dir} 缺少 frontmatter`);
    // pi 只把 name / description 注入 <available_skills>，缺了技能就选不中。
    assert.match(frontmatter[1], /^name:\s*\S+/m);
    assert.match(frontmatter[1], /^description:\s*\S+/m);
    const name = frontmatter[1].match(/^name:\s*(\S+)/m)?.[1];
    assert.equal(name, dir === ADVISOR_DIR ? "xiaohongshu-makeup-advisor" : "makeup-kit");
  }
});

test("商品块契约还在——删了会让商品卡片静默消失", async () => {
  const advisor = await readSkillFile(ADVISOR_DIR, "SKILL.md");
  const happyPath = await readSkillFile(ADVISOR_DIR, "references/happy-path.md");

  for (const [label, body] of [["SKILL.md", advisor], ["happy-path.md", happyPath]] as const) {
    assert.match(body, /looktrace-products/, `${label} 丢了商品块`);
    assert.match(body, /looktrace\.products\.v1/, `${label} 丢了块版本号`);
  }

  // 五个字段一个都不能少：多一个少一个都会被 product-block 的校验拒掉。
  for (const field of ["category", "brand", "name", "shade", "section"]) {
    assert.match(advisor, new RegExp(`\`${field}\``), `商品块字段 ${field} 的说明丢了`);
  }
  assert.match(advisor, /necessary/);
  assert.match(advisor, /optional/);
  // 块里只列 💰 首选，且每品类最多一条。
  assert.match(advisor, /只列每个品类的 `💰` \*\*首选\*\*/);
});

test("「色号待试」策略还在，没被换成绝对色号", async () => {
  const advisor = await readSkillFile(ADVISOR_DIR, "SKILL.md");
  const happyPath = await readSkillFile(ADVISOR_DIR, "references/happy-path.md");
  const research = await readSkillFile(ADVISOR_DIR, "references/research-method.md");

  for (const [label, body] of [["SKILL.md", advisor], ["happy-path.md", happyPath], ["research-method.md", research]] as const) {
    assert.match(body, /色号待试/, `${label} 丢了「色号待试」`);
  }
  // 首轮没有试色依据时不许给绝对色号，这条是产品策略，不是措辞偏好。
  assert.match(happyPath, /不给粉底、遮瑕或唇部产品一个绝对精准的色号/);
  // 上游那套「内部选定肤色基准后给具体色号（参考）」不许回流。
  assert.ok(!/内部选定一组明确/.test(research), "「内部选基准给绝对色号」不该出现在仓库版本里");
});

test("取数只走 xhs_* 工具，没有 node 脚本调用", async () => {
  for (const dir of SKILL_DIRS) {
    for (const file of await walk(dir)) {
      if (!file.endsWith(".md")) continue;
      const body = await readFile(file, "utf8");
      // 技能里出现 node <path> 等于把传输方式焊进技能，且会绕过预算与详情上限闸门。
      assert.ok(!/node\s+\S*scripts\//.test(body), `${file} 出现 node 脚本调用`);
      assert.ok(!/--exclude-note-ids/.test(body), `${file} 出现上游脚本的参数`);
      assert.ok(!/xhs_image_evidence|xhs_video_evidence/.test(body), `${file} 引用了上游脚本`);
    }
  }
  const advisor = await readSkillFile(ADVISOR_DIR, "SKILL.md");
  assert.match(advisor, /xhs_search_notes/);
  assert.match(advisor, /xhs_get_note_detail/);
});

test("不给可点链接：拼出来的 /explore/<id> 打不开", async () => {
  const advisor = await readSkillFile(ADVISOR_DIR, "SKILL.md");
  const happyPath = await readSkillFile(ADVISOR_DIR, "references/happy-path.md");
  const research = await readSkillFile(ADVISOR_DIR, "references/research-method.md");

  for (const [label, body] of [["SKILL.md", advisor], ["happy-path.md", happyPath], ["research-method.md", research]] as const) {
    assert.match(body, /不要自己拼|不给可点链接/, `${label} 丢了「不给可点链接」`);
  }
});

test("妆匣的读取入口只写 kit_list_products，也没有 Codex 的 memory.md", async () => {
  const kit = await readSkillFile(KIT_DIR, "SKILL.md");
  assert.match(kit, /kit_list_products/);
  // 三态必须都在，empty 与 read-failed 不能合并。
  for (const state of ["ok", "empty", "read-failed"]) {
    assert.match(kit, new RegExp(`\`${state}\``), `妆匣技能没写 availability=${state}`);
  }
  assert.match(kit, /不能说用户现实中一定没有/);

  for (const dir of SKILL_DIRS) {
    for (const file of await walk(dir)) {
      const body = await readFile(file, "utf8");
      // Codex 形态（用户给 memory.md）在仓库里不存在，留着会让模型去找一个不存在的文件。
      assert.ok(!/memory\.md/.test(body), `${file} 残留 Codex 的 memory.md 说法`);
      assert.ok(!/agents\/openai/.test(body), `${file} 残留 Codex 打包文件引用`);
    }
  }
});

test("技能里的相对引用都真的存在", async () => {
  // 断掉的引用不会报错，只会让模型读不到那份细则——静默的半套技能。
  for (const dir of SKILL_DIRS) {
    for (const file of await walk(dir)) {
      if (!file.endsWith(".md")) continue;
      const body = await readFile(file, "utf8");
      const links = body.matchAll(/\]\((\.[^)#]+)\)/g);
      for (const [, target] of links) {
        const resolved = resolve(dirname(file), target);
        const exists = await stat(resolved).then(() => true, () => false);
        assert.ok(exists, `${file} 引用了不存在的 ${target}`);
      }
    }
  }
});

test("妆匣技能与代码词表指向同一份 SSOT", async () => {
  const kit = await readSkillFile(KIT_DIR, "SKILL.md");
  const categories = await readSkillFile(KIT_DIR, "references/categories.md");
  // 文本可以解释词表，但必须点名代码是权威来源，否则两处会各自漂。
  assert.match(kit, /lib\/kit\/categories\.ts/);
  assert.match(kit, /lib\/kit\/attributes\.ts/);
  assert.match(categories, /lib\/kit\/categories\.ts/);
  assert.match(categories, /lib\/kit\/attributes\.ts/);
});
