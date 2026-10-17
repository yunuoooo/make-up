# Pi Agent 技能驱动运行时

Status: implemented and live-verified
Date: 2026-09-17
Related specs: [09-24-xhs-api-integration.md](./09-24-xhs-api-integration.md)（取数链路，已取代 09-07 的 MCP 接入设计）

## 0. 文档目的

`lib/pi/bridge.ts` 以 Pi 作为 Agent 运行时。本文记录 Pi 侧技能（Skill）加载链路的修复：Agent 的行为必须来自仓库内的技能文件，而不是 bridge 里的系统提示词副本。

## 1. 问题

改造前的 `buildPiArgs` 同时做了三件事，导致技能从未进入上下文：

- 传 `--no-skills` 且没有传 `--skill`：Pi 跳过技能发现，系统提示词里不会出现 `<available_skills>`。
- `--no-builtin-tools` + `--tools xhs_check_login_status,xhs_search_feeds,xhs_get_feed_detail`：Pi 的技能是按需加载的，模型需要内置 `read` 工具去读 `SKILL.md`；白名单里没有 `read`，技能即使被发现也读不到。
- `DEFAULT_SYSTEM_PROMPT` 用一小段文字复述了技能的研究流程和边界，模型只能照着这段提示词行动，与 `SKILL.md` 各自漂移。

## 2. 方案

技能是行为的唯一来源，bridge 只负责把技能装进运行时并守住只读边界：

- `--skill <repo>/xiaohongshu-makeup-advisor-latest`：显式加载妆容顾问技能，路径可用 `PI_SKILL_PATH` 覆盖。保留 `--no-skills`，让显式路径成为唯一来源，避免发现到无关技能。
- 工具白名单加入内置 `read`，技能的 `SKILL.md` 与 `references/*.md` 才能按需进入上下文。
- 系统提示词只保留运行时约束：可用工具、只读边界、中文回答、脱敏，并明确“技能内容与系统提示词冲突时以技能为准”。
- `runPiAgent` 在 spawn 之前校验 `SKILL.md` 存在；缺失时直接以失败结束，不静默回退到系统提示词。

## 3. 加载链路

```text
buildPiArgs --skill <skillDir>
    -> Pi 扫描该目录，读取 SKILL.md frontmatter（name / description）
    -> 系统提示词注入 <available_skills>（含 name、description、SKILL.md 绝对路径）
    -> 模型按 location 调用 read 读取 SKILL.md
    -> SKILL.md 内的相对路径（references/、scripts/）按 SKILL.md 所在目录解析后再读
```

`xiaohongshu-makeup-advisor-latest/` 通过 `references/happy-path.md` 和 `references/research-method.md` 使用这种渐进披露：常驻上下文的只有描述，正文和细节在命中任务时才读入。

## 4. 验证

- 抓取 Pi 实际发出的模型请求：系统提示词尾部包含 `<available_skills>`，指向 `xiaohongshu-makeup-advisor` 的 `SKILL.md` 绝对路径；工具列表为 `read` + 三个只读 `xhs_*` 工具，写工具与 bash/edit/write 均不可见。
- 真实模型运行（`deepseek/deepseek-chat`，当时的取数链路是本地 XHS MCP，工具名当时叫 `xhs_search_feeds`）：模型先 `read` `SKILL.md`，再读两个 references，然后按技能约定只传 `keyword` 调用搜索工具；其中一次搜索以 `context deadline exceeded` 失败后，按技能的排障说明继续检索并报告实际样本量，没有循环重试卡住的无头实例。
- `test/L1/pi-bridge.test.ts` 固定参数契约：技能路径、`read` 白名单，以及系统提示词不再内联技能规则。
- `test/L3/pi-skill.e2e.test.ts`（`RUN_L3_E2E=1`）用一个本地 mock 模型端点跑通真实 pi 进程：断言系统提示词包含 `<available_skills>` 与 SKILL.md 绝对路径、工具列表含 `read`，并断言模型读到的正是仓库里的 SKILL.md 和 `references/happy-path.md`。把参数改回旧写法（去掉 `--skill` 和 `read`）时该测试会失败。

## 5. 边界

- 运行时仍然只读：白名单外的工具在 Pi 侧不可见，技能里提到的发布、点赞、收藏不会被误触发。
- 技能内容变更不需要改 bridge；新增技能用 `PI_SKILL_PATH` 或扩展 `skillPath` 选项接入。
- **上游缺陷的规避不写在技能里**：技能是行为引导，模型可以忽略；把「上游有缺陷所以别这么调」写进技能，等于把外部服务的 bug 变成了产品行为，而且模型仍可能试探一次、白烧一个超时窗口。
  - 归属原则：**约束跟着有缺陷的那个工具走**。工具适配层（`.pi/extensions/`）能在发出请求之前就挡掉，模型绕不过去，代价为零。
  - 例子：视频笔记曾经在工具层的详情调用里被拦掉（MCP 时代的 `xhs_get_feed_detail`，见 [09-07 第 12 节](./09-07-xhs-mcp-integration.md)），技能文件始终没动；换成 API 链路后改成在检索时就限定图文（[09-24 决策 11](./09-24-xhs-api-integration.md)），约束**仍然跟着工具走**，技能照旧不动。
  - 技能只写业务行为：读几篇、输出格式、证据规则、只读边界——由产品决定，改动走正常评审。
- `PI_CODING_AGENT_DIR` 指向项目内的 `.local-data/pi`，技能通过显式路径加载，不依赖全局技能目录或 `~/.pi`。
- pi 本身是 `package.json` 的依赖（`@earendil-works/pi-coding-agent`），bridge 默认执行 `node_modules/.bin/pi`；`.pi/extensions/` 里用到的 `typebox` 同样是项目依赖，部署物不依赖任何全局安装。可用 `PI_BIN` 覆盖。

## 6. 推理强度：耗时的主开关（2026-10-17）

### 6.1 时间到底花在哪

从 Langfuse 实测（`us.cloud.langfuse.com`，trace 结构见 [09-22](./09-22-langfuse-observability.md) 第 5.1 节）：**一轮妆容 92% 的墙钟是模型生成，工具只占一成多。** 而且生成时间里约 **70–80% 的输出 token 是隐藏的 reasoning**，不是用户看到的正文。

| 一轮（199.2s） | 秒 |
| --- | --- |
| 模型生成 | **183.5（92%）** |
| 其中最终答案那一次 | 119.2（输出 15,124，思考 11,033） |
| 工具（10 次详情 + 3 次搜索） | ~28 |

首 token 延迟只有 0.2–1.0 秒、吞吐 127–222 tok/s，说明**不是网络慢也不是排队**，就是模型在持续思考。所以优化工具没有意义，杠杆在推理强度。

### 6.2 `--thinking` 怎么用，以及为什么它对 `deepseek-chat` 没用

pi 支持 `--thinking <off|minimal|low|medium|high|xhigh|max>`，bridge 通过 `PI_THINKING_LEVEL` 透传（`resolveThinkingLevel`），拼错的值不生效且 `preflight.mjs --env` 会直接判失败。

**但档位能不能落地取决于模型声明了什么。** 实测（pi 的模型目录 + 会话文件里的 `thinking_level_change`）：

| 模型 id | 档位表 | 传 `low` 的结果 |
| --- | --- | --- |
| `deepseek-v4-flash` | `low / high / max` | ✅ 记成 `low` |
| `deepseek-v4-pro` | 只有 `high / max` | ❌ 被**向上夹到 `high`** |
| `deepseek-chat`（我们的缺省） | **不在目录里**，pi 拿 `deepseek-v4-pro` 当模板 | ❌ 同样夹到 `high` |

根因在 pi 的 `buildFallbackModel`：自定义 model id 会克隆 provider 默认模型（`deepseek-v4-pro`）的配置，只改 id/name；而 `clampThinkingLevel` 在请求档位不被支持时**先向上找**最近可用档位，所以 `low` / `medium` 都变成 `high`。pi 自己的缺省档位 `medium` 对这两个模型也不可用——这解释了为什么历史 16 个会话**全部**记的是 `high`。

`deepseek-chat` 不在目录里这件事 [09-25 附录 A.2](./09-25-video-understanding.md) 已经记过一次（当时是查视觉能力），这次是它的第二个后果。

### 6.3 实测 A/B（同一问题、同一妆匣、本地真跑）

| 轮次 | 模型 | 档位 | 耗时 | 输出 token | 其中思考 | 答案字符 |
| --- | --- | --- | --- | --- | --- | --- |
| 基线 | `deepseek-chat` | high（夹） | 110.0s | 17,444 | 12,138 | 5,766 |
| 对照 | `deepseek-v4-flash` | high | 112.1s | 18,203 | 13,097 | 5,716 |
| 处理 | `deepseek-v4-flash` | **low** | **92.5s** | 15,574 | **10,773** | 5,476 |

**思考 token 降 17.7%，耗时降 17.5%——两者几乎一比一。** 答案长度基本不变（-4%），说明降的是盘算时长，不是内容量。

另外 `deepseek-v4-flash` 的单价是 `deepseek-v4-pro` 的约 **1/3**（0.14/0.28 vs 0.435/0.87），而我们的自定义 id 继承的是 pro 的配置与价格档。

### 6.4 结论与待定

- **要真正降档，`PI_MODEL` 得换成声明了 `low` 的模型**（`deepseek-v4-flash` 或 `deepseek-v4-flash-vision-exp`）。这不是纯配置调整——换模型等于换回答质量，需要单独决定。在换之前，`PI_THINKING_LEVEL=low` 对 `deepseek-chat` 是**无效的**（会被静默夹回 high），所以线上暂时不要指望它。
- 技能侧也能省：`search-verified` / `user` 的来源已经可信，**不该再让模型为它们盘算要不要重新检索**。`makeup-kit` 里补上这条豁免，属于「别让它重复盘算已经确定的事」。
- 仍然成立的判断：把已有单品和妆容目标逐件对上本来就要思考，目标不是把思考降到零。
