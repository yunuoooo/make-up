import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kitSourceExtension from "../../.pi/extensions/kit-source.ts";
import { resolveKitUserId } from "../../lib/pi/bridge.ts";
import { createUserProducts } from "../../lib/storage/user-products.ts";
import { summarizeToolCall, summarizeToolResult } from "../../lib/pi/events.ts";

/**
 * 妆匣工具层的不变量。核心只有一条：
 *
 * **「成功读到空妆匣」与「没读到」必须分开。** 混起来，模型就会把「没读到」
 * 说成「你没有」——`makeup-kit/SKILL.md:18` 专门要防这个失败模式，
 * 而用户看到的那两句话含义完全相反。
 *
 * 全部用临时数据目录跑，不碰仓库的 `.local-data`。
 */

type Tool = { description?: string; parameters?: unknown; execute: (id: string, params: unknown) => Promise<any> };

/** 只实现扩展真正用到的那部分 ExtensionAPI。 */
function fakePi() {
  const tools = new Map<string, Tool>();
  return {
    tools,
    api: {
      registerTool: (definition: Tool & { name: string }) => {
        tools.set(definition.name, definition);
      },
      registerCommand: () => undefined
    } as any
  };
}

/** 在当前环境下构造工具（扩展在构造时读 env）。 */
async function construct(): Promise<Tool> {
  const pi = fakePi();
  await kitSourceExtension(pi.api);
  const tool = pi.tools.get("kit_list_products");
  assert.ok(tool, "kit_list_products 必须注册");
  return tool;
}

/**
 * 在指定环境里跑一段。
 *
 * 环境必须在 `execute` **期间**一直有效：存储层是调用时读 `LOOKTRACE_DATA_DIR` 的，
 * 只在构造工具时设好、出了作用域就恢复，会让工具转去读仓库的 `.local-data`，
 * 于是所有用例都看到空妆匣——这正是本文件要防的那类静默错。
 */
async function withEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withDataDir(values: Record<string, string>, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "looktrace-kit-tool-"));
  try {
    await withEnv({ ...values, LOOKTRACE_DATA_DIR: dir }, async () => { await run(dir); });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function payloadOf(result: any): any {
  return JSON.parse(result.content[0].text);
}

test("读到记录时给出归一化品类、派生浓淡与逐属性来源", async () => {
  await withDataDir({}, async (dir) => {
    await createUserProducts("local-user", [
      {
        brand: "示例品牌",
        category: "唇釉",
        shade: "01",
        attributes: { colorFamily: "正红", finish: "哑光", pigmentation: "浓郁" },
        attributeSources: { colorFamily: { source: "model-inferred" } },
        recordSource: "preset"
      },
      { brand: "另一件", category: "底妆" }
    ]);

    const tool = await construct();
    const payload = payloadOf(await tool.execute("call_1", {}));

    assert.equal(payload.availability, "ok");
    assert.equal(payload.scope.total, 2);
    assert.equal(payload.scope.returned, 2);
    assert.equal(payload.reason, undefined, "正常读到就不该带 reason");
    assert.equal(payload.source, "user-products.json");
    assert.equal(payload.userId, "local-user");

    const lip = payload.products.find((product: any) => product.categoryId === "lip");
    assert.equal(lip.category, "唇妆");
    assert.equal(lip.categoryRaw, "唇釉");
    assert.equal(lip.intensity, "浓郁", "浓淡由服务端算好，不让模型换算");
    assert.equal(lip.recordSource, "preset");
    assert.deepEqual(lip.attributeSources.colorFamily, { source: "model-inferred" });

    // 没填特点的那件：attributes 为空只表示未知，不是「没有该属性」。
    const base = payload.products.find((product: any) => product.categoryId === "base");
    assert.deepEqual(base.attributes, {});
    assert.equal(base.intensity, undefined);
    assert.equal(dir.length > 0, true);
  });
});

test("按品类过滤，并区分「妆匣是空的」与「这个品类没有记录」", async () => {
  await withDataDir({}, async () => {
    await createUserProducts("local-user", [{ brand: "示例品牌", category: "底妆" }]);
    const tool = await construct();

    const hit = payloadOf(await tool.execute("call_1", { categoryId: "base" }));
    assert.equal(hit.availability, "ok");
    assert.equal(hit.scope.filteredByCategory, "base");
    assert.equal(hit.scope.returned, 1);

    // 读到了、只是这个品类没有：仍是成功读取，**不能降级成 read-failed**。
    const miss = payloadOf(await tool.execute("call_2", { categoryId: "lip" }));
    assert.equal(miss.availability, "ok");
    assert.equal(miss.scope.total, 1);
    assert.equal(miss.scope.returned, 0);
    assert.deepEqual(miss.products, []);
    assert.equal(miss.reason, "kit-no-category");
    assert.match(miss.message, /不代表用户没有/);
  });
});

test("没有妆匣文件＝成功读到空妆匣，不是故障", async () => {
  await withDataDir({}, async () => {
    const tool = await construct();
    const result = await tool.execute("call_1", {});
    const payload = payloadOf(result);

    assert.equal(payload.availability, "empty");
    assert.equal(payload.reason, "kit-empty");
    assert.deepEqual(payload.products, []);
    assert.equal(payload.scope.total, 0);
    // 「未记录」不等于「没有」——文案必须挡住这个推论。
    assert.match(payload.message, /不能说用户现实中一定没有/);
    // 预期内结果 return，不 throw，details 上带 reason 供过程区显示。
    assert.equal(result.details.reason, "kit-empty");
  });
});

test("文件在但读不懂＝没取得数据，绝不能当成空妆匣", async () => {
  await withDataDir({}, async (dir) => {
    // 截断的 JSON：`readJson` 会静默返回 fallback，那样「坏了」会伪装成「空的」。
    await writeFile(join(dir, "user-products.json"), '[{"id":"prod_1","brand":"示例品', "utf8");

    const tool = await construct();
    const payload = payloadOf(await tool.execute("call_1", {}));

    assert.equal(payload.availability, "read-failed");
    assert.equal(payload.reason, "kit-read-failed");
    assert.match(payload.message, /没有取得妆匣数据/);
    assert.ok(!("products" in payload), "读失败时不能给出空的 products 列表，那会被读成「没有」");
  });
});

test("非标准品类在读取之前就被拒", async () => {
  await withDataDir({}, async () => {
    await createUserProducts("local-user", [{ brand: "示例品牌", category: "底妆" }]);
    const tool = await construct();

    for (const categoryId of ["口红", "lipstick", ""]) {
      if (!categoryId) continue;
      const payload = payloadOf(await tool.execute("call_1", { categoryId }));
      // 归一化是工具的事：模型要给 categoryId，给中文名不算标准取值。
      assert.equal(payload.reason, "bad-argument", `${categoryId} 应被拒`);
      assert.equal(payload.availability, undefined);
    }
  });
});

test("件数超过上限时截断，并说明怎么缩小范围", async () => {
  await withDataDir({ KIT_LIST_LIMIT: "2" }, async () => {
    await createUserProducts("local-user", Array.from({ length: 5 }, (_, index) => ({
      brand: `品牌${index}`,
      category: "唇妆"
    })));

    const tool = await construct();
    const payload = payloadOf(await tool.execute("call_1", {}));

    assert.equal(payload.scope.total, 5);
    assert.equal(payload.scope.returned, 2);
    assert.equal(payload.truncated, true);
    assert.match(payload.message, /categoryId/);
  });
});

test("工具不接受 userId，身份只来自运行时注入", async () => {
  const tool = await construct();
  // 参数表里没有 userId：模型因此没有切换用户的入口。
  assert.ok(!JSON.stringify(tool.parameters).includes("userId"));

  await withDataDir({ LOOKTRACE_USER_ID: "u_42" }, async () => {
    const scoped = await construct();
    const payload = payloadOf(await scoped.execute("call_1", {}));
    // 身份如实回显，但它是环境给的，不是调用方给的。
    assert.equal(payload.userId, "u_42");
    // 另一个用户的妆匣不该被这个身份的调用看到。
    await createUserProducts("someone-else", [{ brand: "别人的", category: "唇妆" }]);
    const other = payloadOf(await scoped.execute("call_2", {}));
    assert.equal(other.availability, "empty");
  });
});

test("工具的缺省用户与 bridge 注入的保持一致", () => {
  // 两处各写了一次缺省值，靠这条钉住它们不许漂。
  assert.equal(resolveKitUserId({}), "local-user");
});

test("三个妆匣结果在前端都有可读文案", async () => {
  const text = (body: unknown) => JSON.stringify(body);
  const summarize = (payload: unknown) =>
    summarizeToolResult("kit_list_products", { content: [{ type: "text", text: text(payload) }] });

  assert.equal(summarizeToolCall("kit_list_products", {}), "核对妆匣");
  assert.equal(summarizeToolCall("kit_list_products", { categoryId: "lip" }), "核对妆匣｜lip");

  // 走真实 payload：reason 在正文里，过程区据此显示人话而不是裸码。
  await withDataDir({}, async () => {
    const empty = payloadOf(await (await construct()).execute("call_1", {}));
    assert.equal(summarize(empty), "妆匣还没有记录");
  });

  assert.equal(summarize({ availability: "read-failed", reason: "kit-read-failed" }), "妆匣没读到");
  assert.equal(summarize({ availability: "ok", reason: "kit-no-category" }), "妆匣未记录该品类");

  // 兜底：万一 payload 少了 reason，也绝不能退成「妆匣 0 件」——那是把「没读到」显示成「你没有」。
  assert.equal(summarize({ availability: "read-failed" }), "妆匣没读到");
  assert.equal(summarize({ availability: "empty" }), "妆匣还没有记录");
  assert.equal(
    summarize({ availability: "ok", scope: { total: 9, returned: 3, filteredByCategory: "lip" } }),
    "妆匣 9 件，lip 3 件"
  );
  assert.equal(summarize({ availability: "ok", scope: { total: 9, returned: 9 } }), "妆匣 9 件");
});
