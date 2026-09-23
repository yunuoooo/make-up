# 会话上下文：把 Pi 原生 Session 接进对话链路

Status: implemented and live-verified
Date: 2026-09-23
Related specs: [09-17-pi-skill-runtime.md](./09-17-pi-skill-runtime.md) · [09-07-xhs-mcp-integration.md](./09-07-xhs-mcp-integration.md) · [09-22-langfuse-observability.md](./09-22-langfuse-observability.md) · [09-21-taobao-product-cards.md](./09-21-taobao-product-cards.md)

## 0. 文档目的

技能的双阶段流程要求第二阶段复述并复用第一阶段的结果，而当前运行时每一轮都是全新进程、全新上下文。本文记录这个缺口的证据、方案取舍、要定的契约，以及需要产品侧拍板的决策点。

## 1. 需求

`references/happy-path.md` 是**双阶段**流程，第二阶段不是独立任务，是首轮的延续：

- 第 5 节：**复用首轮已经确认的妆容指纹**，不机械重复全部通用研究；只重搜受用户条件影响的品类。
- 第 6 节第 1–2 条：最终消息要先**简短列出已采用的肤质、肤色、预算、发色、假睫毛偏好和风格分支**，再说明**相对通用版改变了哪些色调、质地、实现路线或优先级，以及原因**。
- `SKILL.md` 输出流程第 3 条同上。

也就是说，"第二阶段能看到第一阶段"是技能流程的硬需求，不是体验优化：没有它，模型既无法复用指纹，也无法说出"相对通用版改了什么"——它连通用版是什么都不知道。

## 2. 现状与缺口证据

| 位置 | 现状 |
| --- | --- |
| `lib/pi/bridge.ts:90` | `buildPiArgs` 固定传 `--no-session`：每轮 spawn 一个全新 pi 进程，进程退出上下文即消失 |
| `frontend/hooks/useConversations.ts:30-33` | 对话记录只存 localStorage，注释写明「保存的是『给用户回看』的副本，不是 Agent 的上下文」 |
| `frontend/lib/constants.ts:49` | `STATELESS_NOTICE`：界面已经如实告诉用户「Agent 每轮独立运行，追问不会带上此前的对话内容」 |
| `app/api/chat/route.ts:108-116` | `conversationId` 只进 trace 元数据（Langfuse 归因），不影响模型上下文 |
| `lib/pi/bridge.ts:122` | bridge 在缺 `conversationId` 时自造 `conv_<uuid>`，每轮一个新值，无法作为会话键 |

实测（2026-09-23，`pi` 0.85.x，`--no-session`）：同一 `conversationId` 连发两轮，第二轮进程的上下文里没有任何第一轮的痕迹。此时走 happy path 的第二阶段，模型只看到用户当轮那一句补充信息，会退回重做一遍通用研究，并且拿不到首轮已确认的妆容指纹和产品候选。

## 3. 方案对比

| 方案 | 说明 | 结论 |
| --- | --- | --- |
| **A. Pi 原生 session** | 去掉 `--no-session`，改用 `--session-id <conversationId>`（找不到就新建）。上下文由 pi 的 `buildSessionContext()` 重建，含工具结果、压缩与分支 | **采用** |
| B. 服务端重放历史 | 服务端把历史 turn 拼成前缀注入 prompt | 拒绝：要自己实现裁剪/摘要/工具结果序列化，每轮重复发送全部历史（token 线性上涨），并与 localStorage 形成第二份真相 |
| C. 客户端回传历史 | 客户端把 turns 发回服务端拼接 | 拒绝：同 B 的成本，还把上下文正确性交给不可信客户端 |

选 A 的额外好处：会话记录落在磁盘上，第二阶段的"首轮结论"不再依赖浏览器 localStorage 是否还在。

**已实测确认的前提**（`--session-id` 在 `-p` 非交互模式下可用）：

- 同一 `--session-id` 连续两次调用，第二次复用同一 JSONL 并追加；文件只在第一次创建时生成，名为 `<timestamp>_<sessionId>.jsonl`。
- 落盘位置 = `<PI_CODING_AGENT_DIR>/sessions/--<cwd-slug>--/<timestamp>_<sessionId>.jsonl`；项目当前设置下即 `.local-data/pi/sessions/--Users-william-make-up--/…`，保持「部署物自包含」。
- `--session-id` 与 `--session`/`--continue`/`--resume` 互斥（pi 会报错退出）；与 `--no-session` 同时存在时 **`--no-session` 优先**（走 `SessionManager.inMemory`），所以必须真删掉它，而不是加上 `--session-id` 就完事。
- id 必须匹配 `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`；不合法时 pi 直接 `process.exit(1)`，只有 stderr 一行。
- 会话文件随第一次追加消息才落盘（空会话不建文件）。

## 4. 设计

### 4.1 会话身份

- 沿用客户端生成的 `conversationId`（`makeClientId("conversation")` → `conversation_<uuid>`，`frontend/lib/formatters.ts:4`）：一轮内不变，新建对话换新 id，`loadConversation` 恢复原 id。**不再由服务端生成**，它就是 pi 的 session id。
- 服务端在调用 bridge 前校验（新增 `lib/pi/session.ts`）：
  - 匹配上面的字符集正则，且长度 ≤ 128；
  - 不合法 → `400`，不下发 pi。理由有二：id 会成为文件名的一部分（路径安全），以及 pi 自己的失败形态是 `exit(1)` + stderr，与我们对前端的错误契约不一致。
- **chat 链路必须显式传**：`/api/chat` 缺字段或 id 不合法一律 400，不再有"没有就算了"的路径。
- bridge 自身在缺失 / 非法 id 时**明确降级为单轮无状态**（传 `--no-session`），并在 status 事件里如实标注 `sessionId: null, ephemeral: true`。
  - 与原计划（"直接失败"）的差别：失败会让 bridge 无法再被单独使用（L3 测试、后续 CLI 场景都需要无会话的一轮）。要守住的是"不能**悄悄**退回无状态、不能自造一个每轮都不同的 id 冒充会话"——降级是声明式的，前端和观测都看得见，这两个约束都还在。

### 4.2 参数与落盘

- `buildPiArgs`：删除 `--no-session`，新增 `--session-id=<conversationId>`；`--continue`/`--resume`/`--session` 一律不传。
- 落盘沿用默认：`PI_CODING_AGENT_DIR=.local-data/pi` → `.local-data/pi/sessions/--<cwd>--/`。可选覆盖按 pi 的优先级：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > 项目 `.pi/settings.json` 的 `sessionDir`。本次**不新增配置**，也不往 `.pi/settings.json` 写 `sessionDir`，避免同一件事有两个地方可配。
- 服务端不需要自建索引：`--session-id` 本身就是 resume-or-create。若要给界面提供"列出/删除服务端会话"，用包根导出的 `SessionManager`（`SessionManager.list(cwd, sessionDir)` / `SessionManager.open(path)`），不自己解析 JSONL 格式——格式有版本（当前 v3）且会迁移。

### 4.3 SSE 与前端契约

- `status` 事件已带 `conversationId`（`lib/pi/bridge.ts:199`），补两项：
  - `sessionFound: boolean`：本轮是续话还是新建。前端据此在"服务端已无此会话"时如实提示，而不是让用户以为前文还在。
  - 其余字段不变；`run.conversationId` 语义从"trace 归因标签"升级为"会话键"，仍是同一个值。
- `ConversationSummary` 不新增字段：`id` 即 session id。
- `STATELESS_NOTICE` 的语义已经过时：改名为 `RESUMABLE_NOTICE` 并改成"继续追问会带上此前轮次的研究结论"，另加一条 `SESSION_MISSING_NOTICE` 用于服务端会话已不在时如实提示。
- **前端回放仍走 localStorage**，本次不改成以服务端会话为准：一次只动一头，避免"界面历史与服务端上下文不一致"这类新缺口。副作用是两者可能不一致（用户清了浏览器数据 / 服务端被清理），由 `sessionFound: false` 兜底提示。

### 4.4 并发

- 同一 `conversationId` 的并发请求 = 两个 pi 进程操作同一 JSONL。前端 `isSendingRef` 只挡得住同一个标签页。
- 做法：服务端按 `conversationId` 加进程内互斥（`lib/pi/conversation-lock.ts`），进行中再来 → `409` + 文案"这个对话还在生成上一条回复，请稍候再问"。锁在流收尾与请求中断两处释放。单实例部署够用；多实例部署需要外部锁，标为待确认。

### 4.5 失败与中断

- 实测：模型调用报错时，pi 仍会把该 assistant 消息（`stopReason: "error"`，`errorMessage` 带上游原文）写进会话文件。这意味着**错误消息会进入下一轮的上下文**。
- 取消（用户切走、请求 abort → SIGTERM）同理可能留下半截 assistant。
- 本次不做清理，交给 pi 的既有行为；但要在 L3 测试里把行为固定下来，避免以后误判为我们的 bug。注意 `errorMessage` 里可能有上游返回的密钥片段（实测出现过 `****12c is invalid` 这种脱敏后的 key 尾），属于第 4.6 节的落盘范围。

### 4.6 隐私与留存

落盘是**新增的一份敏感数据**，与"输出脱敏"是两件事：

- 会话 JSONL 里含 `xhs_*` 工具结果原文：笔记正文、图片 URL、`xsec_token`、Cookie 相关字段（以工具实际返回为准）。当前 `redactSensitive` 只作用于 SSE 与答案（`lib/pi/bridge.ts:174,288,291`），**对落盘无效**。
- **实现期修正**：本节原先建议"在工具层抹掉 `xsec_token`"，前提"模型不需要 token"是错的。上游 `get_feed_detail` 强制要求 `xsec_token`，值来自 `search_feeds` 返回的 `xsecToken` 字段（`xiaohongshu-mcp/mcp_server.go:59`、`mcp-handlers.go:363`：缺参直接返回"缺少 xsec_token 参数"）。一律抹掉会让模型再也读不了任何笔记详情，正好打断本 spec 要支持的跨轮流程。
  - 要做到"落盘无 token"只有一条路：扩展记住 `feed_id → xsec_token`，对模型只暴露 `feed_id`，调用上游前自己补 token。代价是**跨轮的详情读取会冷缓存失败**——第二轮进程里缓存是空的，而第一轮留在会话里的搜索结果已经没有 token 了。会话本来就要求模型能在后续轮次继续读详情，这个代价和目的直接冲突。
  - 因此本次**不改工具层**。落盘里的 token 属于"过期即失效的笔记访问令牌"，不是用户账号凭据（Cookie 只在上游进程里，从不进工具返回）。真正的防线是第 4.6 节的留存与删除，以及 `parsePiJsonLine`（`lib/pi/events.ts:23`）已经覆盖的 SSE 与 trace 脱敏。
  - 若以后仍要抹掉：应当同时把 `feed_id → token` 的映射持久化到会话之外（而不是进程内存），否则跨轮读取必然退化。
- 留存：`.local-data/pi/sessions/` 现在有上限——界面删除对话时调 `DELETE /api/sessions/[id]` 连文件一起删；服务端另按条数/时间过期（`pruneSessions`，默认值见第 8 节），在聊天请求路径上每十分钟最多清理一次。
- **多用户边界**：目前只有 `local-user`，会话目录不按用户分区，知道 `conversationId` 即可续上别人的上下文。单机单用户下可接受，多租户前必须改造。
- `stderr` 之前 `pipe` 但从不消费（`lib/pi/bridge.ts:253`）：接入 session 后 pi 会在 stderr 写 "No project session found with id …"、错误栈等内容，管道写满 64 KB 会阻塞子进程。已改为消费，并保留最后 20 行、失败时取末 5 行（脱敏后）附到错误消息里——否则那些原因哪儿都看不到。

### 4.7 上下文预算与压缩

- 轮次累积后 pi 会自动压缩：阈值 `contextTokens > contextWindow - reserveTokens`（默认 `reserveTokens` 16384，`keepRecentTokens` 默认 20k，可在 settings.json 调）。
- 风险：happy path 第二阶段需要**精确**复用首轮的妆容指纹与产品候选；压缩后它们只剩 LLM 摘要，模型可能重搜或给出与首轮不一致的候选。
- 本次不改 pi 的压缩参数，把一致性交给技能（第二阶段本来就要复核版本、色号、在售）。若要更强保证，再加"每轮把首轮 `looktrace-products` 块以 `custom_message` 注入"（见第 8 节）。
- 需要注意的连带项：`--mode json` 的 `message_update` 流不受压缩影响，SSE 契约不变。

## 5. 配置

不新增必填项。可选覆盖与 pi 现有约定一致：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | `.local-data/pi` | 已有；会话随之落在 `.local-data/pi/sessions/` |
| `PI_CODING_AGENT_SESSION_DIR` | 未设置 | 可选；想单独挪走会话目录时才用（优先级低于 `--session-dir`） |

## 6. 测试计划

- **L1 `test/L1/pi-bridge.test.ts`（扩展）**：参数契约——给 id 时含 `--session-id=<conversationId>` 且不再含 `--no-session`，不含 `--session`/`--continue`/`--resume`；缺 id 或 id 非法时退回 `--no-session` 并标注 `ephemeral`，绝不自造 id。
- **L1 `test/L1/pi-session.test.ts`（新增）**：id 校验（合法字符集、长度、`..`/`/` 之类的注入）、会话路径推导、`sessionFound` 语义。
- **L1 `test/L1/frontend-runtime.test.ts`（扩展）**：`STATELESS_NOTICE` 文案变更（若采纳）。**实际未做**：仓库没有 React 渲染测试环境，只断言文案等于把用户可见的措辞锁死，改文案就得改测试。`isSessionMissing → SESSION_MISSING_NOTICE` 的接线目前只有类型检查兜底。
- **L3 `test/L3/pi-session.e2e.test.ts`（新增）**：复用 `pi-skill.e2e.test.ts` 的本地 mock 模型端点模式，跑**两个真实 pi 进程**、同一 `--session-id`：
  1. 第二轮请求的 `messages` 里包含第一轮的 user 文本与助手回答；
  2. `sessions/` 下只产生一个文件，且会话 id 等于传入的 id；
  3. 反证：把参数改回 `--no-session`，该断言必须失败。
- 并发互斥、删除联动这类服务端行为用 L1 覆盖（不依赖真实 pi）。

## 7. 实现清单

1. `lib/pi/session.ts`（新）：id 校验、会话路径/存在性、列出与删除。
2. `lib/pi/bridge.ts`：参数改造、`conversationId` 必填、`status` 事件补 `sessionFound`、消费 stderr。
3. `app/api/chat/route.ts`：400 校验与并发互斥。
4. `.pi/extensions/xiaohongshu-mcp.ts`：工具层脱敏 `xsec_token`（若采纳 4.6）。
5. 前端：`STATELESS_NOTICE` 文案、`sessionFound` 提示、删除对话时的服务端联动。
6. `README.md` / `AGENTS.md`：运行时边界里补一句"会话落在 `.local-data/pi/sessions/`"。

## 8. 决策（2026-09-23 已定）

| # | 决策点 | 结论 |
| --- | --- | --- |
| 1 | 删除对话时是否连服务端 session 文件一起删 | 是：`DELETE /api/sessions/[id]`，界面删除时同步调用；服务端删失败会明确提示"本地记录已删除，但服务端会话没有删掉" |
| 2 | 服务端会话留存上限 | 条数 30（对齐 localStorage）+ 30 天 TTL，在聊天请求路径上每十分钟最多清理一次（`pruneSessionsThrottled`） |
| 3 | `xsec_token` 脱敏放在工具层还是落盘清理 | **都不做**：工具层脱敏会打断 `get_feed_detail`（见 4.6 实现期修正）。改为依赖留存上限、删除联动，以及已有的 SSE/trace 脱敏 |
| 4 | 并发冲突：409 还是排队 | 409 + 明确文案；锁在进程内（`lib/pi/conversation-lock.ts`），多实例需外部锁 |
| 5 | 是否把首轮 `looktrace-products` 块作为 `custom_message` 重新注入以防压缩 | 本次不做，先观察真实长会话里的压缩行为 |
| 6 | 界面历史是否改为以服务端会话为准 | 本次不改：localStorage 回放 + `sessionFound` 兜底 |
| 7 | `STATELESS_NOTICE` 删除还是改文案 | 改名 `RESUMABLE_NOTICE` + 改文案（"继续追问会带上此前轮次的研究结论"），并新增 `SESSION_MISSING_NOTICE` |

## 9. 验证记录（2026-09-23）

L1（`npm test`，82 条中 80 通过、2 条 L3 跳过）：

- `test/L1/pi-bridge.test.ts`：参数含 `--session-id` 且不再含 `--no-session`；不与 `--session`/`--continue`/`--resume` 并用；无 id / 非法 id 退回 `--no-session`；无会话的 status 事件为 `sessionId: null, ephemeral: true`。
- `test/L1/pi-session.test.ts`：id 字符集与长度、路径穿越拒绝；项目会话目录名与 pi 一致（防命名规则漂移）；按文件头而非文件名后缀匹配会话（`x_conversation_a` 不会撞上 `conversation_a`）；删除只删目标文件；按过期与超额清理；status 的 `sessionFound` 取自磁盘实际文件。
- `test/L1/conversation-lock.test.ts`：同一会话第二次获取失败、不同会话互不影响、释放幂等。

L3（`RUN_L3_E2E=1 npm run test:l3`，真实 pi 进程 + mock 模型端点）：

- `test/L3/pi-session.e2e.test.ts`：两轮同一会话 id，**第二轮请求的 `messages` 里出现第一轮的问与答**；同一会话只产生一个 JSONL 文件且内容含两轮；无会话键的一轮既看不到前文、也不落盘（反证上下文确实来自会话）。

生产构建下的 HTTP 验证（`next build` + `next start -p 3100`，用 sleep 脚本充当 `PI_BIN`，不产生模型费用）：

| 用例 | 结果 |
| --- | --- |
| `conversationId: "../../etc/passwd"` / 缺字段 | `400 {"error":"会话标识无效，请重新开始一个对话。"}` |
| 已有会话文件 | status 事件 `sessionFound: true` |
| 未建过的会话 | status 事件 `sessionFound: false` |
| 同一会话两轮重叠 | 第二个请求 `409`；不同会话 `200`；上一轮结束后再问 `200`（锁正确释放） |
| `DELETE /api/sessions/<id>` | `200 {"ok":true}`，文件消失；重复删除与非法 id 均 `404` |

未验证：真实模型下的长会话压缩行为（决策 5 留待观察）；多实例部署的会话锁。

## 10. 顺带修掉的既有问题：dev 下 instrumentation 编译不过（2026-09-23）

**现象**：`npm run dev` 起不来 `/api/chat`，启动日志即报 `Module not found: Can't resolve 'stream'`，链路是 `instrumentation.ts → lib/observability/langfuse.ts → @opentelemetry/sdk-node → otlp-grpc-exporter-base → @grpc/grpc-js`。生产构建正常，所以线上没暴露。

**根因**（用 webpack 配置探针确认，不是猜的）：Next 会为三个编译单元各编译一次 `instrumentation.ts`：

| 编译单元 | target | 结果 |
| --- | --- | --- |
| node | `node18.17` | Node 内置模块可用，正常 |
| edge | `["web","es6"]` | **没有 Node 内置模块，解析整条 OTel 链必然失败** |
| client | `["web","es6"]` | 不含 instrumentation，正常 |

`register()` 里的 `NEXT_RUNTIME !== "nodejs"` 守卫是**运行时**判断，webpack 只做静态分析，照样会为 edge 解析动态 import 的整条依赖链。生产构建先做 DCE 把这条不可达分支删掉，所以只在 dev 暴露。`serverExternalPackages` 只作用于 node 编译单元，对 edge 无效——按包名逐个外置是追不完的（补掉 `@grpc/grpc-js` 后立刻换成 `@grpc/proto-loader`）。

**修法**（`next.config.mjs`）：node 编译单元用 `serverExternalPackages` 把 OTel 链排除出打包；edge 编译单元把三个入口 alias 成空模块，编译期不再跟着走，运行时也碰不到（守卫先行返回）。

**验证**：dev 启动零解析错误，`/api/chat` 的 400 / `sessionFound` / DELETE 三项行为与生产一致；`npm run build` 与 `next start` 冒烟通过。两者的配对关系由 `test/L1/observability-langfuse.test.ts` 的 `keeps the observability import behind the Node runtime guard` 钉住——守卫被拿掉时，edge 下会静默拿到空对象，比编译不过更难查。
