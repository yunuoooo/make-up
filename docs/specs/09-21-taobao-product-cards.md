# 淘宝商品卡片：确定性选品补全与可滑动卡片

Status: implemented and live-verified
Date: 2026-09-21
Related specs: [001-mvp.md](./001-mvp.md) · [09-07-xhs-mcp-integration.md](./09-07-xhs-mcp-integration.md) · [09-17-pi-skill-runtime.md](./09-17-pi-skill-runtime.md)

## 0. 文档目的

Happy Path 已经能给出「必要／非必要」两张选品拆解表，但表里的 `💰` 只是文字：用户拿不到商品图，也点不到淘宝。本文规定在那张表**已经确定了商品之后**，如何确定性地调淘宝接口取回图片和链接，并把它们做成一条可滑动的商品卡片。

补全的商品清单来自 Agent 已经写定答案里的 `💰` 首选（第 1 节），淘宝只负责补图、补价、补链接——选品逻辑仍然只在技能里。

## 1. 需求

1. 用户搜索妆容后，Happy Path 输出选品表，其中 `💰` 是「按当前方案采用该单品需要新增购买」。
2. 对这批**已经确定**的商品，逐个调淘宝的**关键词搜索**接口，再调**商品详情**接口。
3. 每件商品只取**第一张**商品图，做成**可左右滑动**的卡片。
4. 卡片上给出该商品的**淘宝详情链接**。

卡片只是导购入口：不改变答案正文、不代替表格、不让模型编链接。

## 2. 范围

**做**：机器可读商品清单的产出与校验、淘宝适配器、卡片补全编排与缓存、`product_cards` SSE 事件、前端可滑动卡片条、失败降级。

**不做**：加购、下单、支付、返利/淘客结算、跨平台比价、价格监控与降价提醒、库存承诺、把卡片写进模型上下文、把链接写进表格正文。

后三项是边界而不是待办：模型不能见过链接，也不能在答案里自己拼 `s.taobao.com/search?q=` 冒充商品链接（[001-mvp.md](./001-mvp.md) 的 MUST NOT 仍然生效）。

## 3. 现状

- `/api/chat` → `runPiAgent`（`lib/pi/bridge.ts`）spawn pi，把 `status`／`text_delta`／`tool_*`／`result` 事件转成 SSE 给前端。
- 答案的**唯一**形态是 Markdown：技能（`xiaohongshu-makeup-advisor-latest/SKILL.md` + `references/happy-path.md`）规定输出两张表，`frontend/components/chat/AdvisorMessage.tsx` 把 `💰`／`✅` 渲染成徽章。
- 服务端**拿不到任何结构化商品**：表格是自由文本，抠品牌和品名不可靠。
- 淘宝线从未实现过：删掉的 `lib/adapters/taobao.ts` 和 `agent_service/tools/taobao.py` 都只是占位，返回「待淘宝 API 接入」。`.env` 里的 `TAOBAO_API_KEY`／`TAOBAO_API_SECRET` 目前为空。

## 4. 已确认的决策

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 淘宝接口形态 | 第三方聚合中转 **Just One API**：商品搜索 V2 + 商品详情 V3，`token` 查询参数鉴权 | 不需要淘宝开放平台的企业资质和淘宝客备案；字段与错误码见 [09-21-justoneapi-taobao-ssot.md](./09-21-justoneapi-taobao-ssot.md)（下称 SSOT） |
| 卡片覆盖范围 | 只放 `💰` **首选**（含「必要」与「非必要」两张表的首选，每品类最多一件） | `✅` 已有单品不需要购买链接；备选只留在表格里 |
| 清单来源 | 技能在答案末尾输出机器可读块，服务端严格校验后使用 | 不改表格正文、不增加模型轮次、可校验可降级；比抠 Markdown 表格可靠 |
| 补全执行方 | 服务端（Next.js 进程），不是 pi 工具 | 选品已定，补全是机械动作；不进模型上下文＝不会被改写成假链接 |

## 5. 数据流

```text
pi 运行（技能驱动研究 + 写答案）
  └─ 答案末尾附一个 ```looktrace-products 块（只列 💰 首选）
        ↓
app/api/chat/route.ts 缓冲 result 事件
        ↓
lib/commerce/product-block.ts：校验块 → ProductRef[]，并从答案正文剥离该块
        ↓
emit result（正文已不含块）
        ↓
lib/commerce/cards.ts：逐件补全（并发 2 + 单件失败隔离 + 24h 缓存）
        ↓
lib/commerce/taobao.ts：搜索 V2 定位 item_id → 详情 V3 取主图与 detail_url（格式见 SSOT）
        ↓
emit product_cards（渐进：pending → 逐张 → done）
        ↓
frontend/hooks/useChat.ts：挂到本轮 turn.cards
        ↓
frontend/components/chat/ProductCardStrip.tsx：答案下方横向 scroll-snap 卡片条
```

`result` 先于 `product_cards` 发出，是有意的：答案在 `result` 时就已经完整可用，卡片是追加内容，用户不必等淘宝。代价是前端要按 `turn.answer` 而不是 `isSending` 判断「本轮是否还在流式」（见第 8 节）。

## 6. 契约

### 6.1 技能输出的机器可读块

技能在**给出含 `💰` 的最终选品表时**，于答案最末尾追加**唯一一个** fenced 块：

````markdown
```looktrace-products
{"version":"looktrace.products.v1","items":[
  {"category":"粉底液","brand":"兰蔻","name":"菁纯臻颜精华粉底液","shade":"BO-01","section":"necessary"},
  {"category":"唇妆","brand":"MAC","name":"子弹头口红","shade":"","section":"optional"}
]}
```
````

规则（写进 `SKILL.md` 的呈现规则 + `references/happy-path.md` 的输出步骤）：

- 只列 `💰` **首选**：每个品类最多一条；备选、`✅`、没被选作首选的路线都不进块。
- `section` 取 `necessary`（必要表）或 `optional`（非必要表），决定卡片上的「核心／按需」标。
- `shade` 允许为空字符串。色号待试时留空，**不得**把「色号待试」这类占位词写进字段——它会进搜索词。
- 块内只允许出现这五个字段。**不得**写价格、链接、图片 URL、笔记 token、来源 URL。
- 块对用户不可见：服务端在 `result` 前剥离，前端在流式阶段也不渲染（第 8 节）。
- 本轮没有任何 `💰` 首选时，不输出块。

校验规则（`lib/commerce/product-block.ts`，严格失败即降级）：

- `version` 必须等于 `looktrace.products.v1`；`items` 必须是 1 条以上的数组，超过 `TAOBAO_CARD_LIMIT`（默认 8）时取前 N 条。
- `category`／`brand`／`name` 必须是非空字符串且 ≤ 60 字；`shade` 可空且 ≤ 40 字；`section` 必须是 `necessary`／`optional`（缺省按 `necessary`）。
- 按 `brand|name|shade` 归一化去重，保留首次出现顺序。
- 出现多个块时（模型把「必要／非必要」拆成两个块写）：合并所有能解析的块的条目，跨块去重后再截断到上限——只认第一个块会丢掉可选清单。
- 块存在但解析失败：**仍然剥离**（否则原始 JSON 会显示给用户），但不产生任何卡片。

### 6.2 淘宝适配器

字段名、错误码、超时规则**全部以 SSOT 为准**，本节只定义内部接口形状。

```ts
// lib/commerce/types.ts
export type TaobaoSearchItem = {
  numIid: string;       // 搜索 V2 的 item_id
  title: string;        // 已去 HTML 高亮标签
  picUrl?: string;      // uprightImg → pic_path，已升级到 https
  price?: string;
  shop?: string;
  isP4p: boolean;       // 上游广告位标记，选品时跳过
};

export type TaobaoItemDetail = {
  numIid: string;
  title: string;
  images: string[];     // 已补 https；消费方只取 [0]
  price?: string;
  detailUrl?: string;   // 卡片链接的正规来源
  shop?: string;
};

// lib/commerce/taobao.ts
export function createTaobaoClient(options?: {
  fetchImpl?: typeof fetch;                  // 测试注入
  env?: Record<string, string | undefined>;  // 测试注入
}): {
  configured: boolean;
  searchItems(keyword: string, options?: { page?: number }): Promise<TaobaoSearchItem[]>;
  getItemDetail(itemId: string): Promise<TaobaoItemDetail | null>;
};
```

- 两个方法对应 SSOT 的 `GET /api/taobao/search-item-list/v2`（搜索）与 `GET /api/taobao/get-item-detail/v3`（详情），鉴权为 `token` 查询参数，`page` 固定传 `1`。
- 详情接口一次只接一个 `itemId`，**接口就是单品形状**，不做 `getItemDetails(ids)` 这种假批量。
- 上游信封是 `{code, message, data, requestId}`：`code !== 0` 时抛 `TaobaoApiError`（带 `code` 和 `requestId`），由编排层按 SSOT 第 3 节的表决定重试、放弃还是整批停止。**HTTP 状态不参与判断**。
- 映射时只读 SSOT 第 4/6 节列出的白名单字段：搜索的 320 KB 页内状态、详情的 `desc` HTML、`url_log`／`_ddf` 等诊断字段一律不进入返回值。
- 供应商差异（换 base URL、换接口版本、字段改名）只允许出现在 `lib/commerce/taobao.ts` 一处；上层模块不感知供应商。
- `configured` 为 false（缺 `TAOBAO_API_TOKEN`）时**不发任何请求**，`searchItems` 返回空数组、`getItemDetail` 返回 null。
- 日志只写 `path` + 业务码 + `requestId`：token 在 query string 里，完整 URL 不能落日志。

### 6.3 SSE 事件 `product_cards`

```ts
// lib/commerce/types.ts
export type ProductCard = {
  id: string;                 // 归一化 brand|name|shade，做 React key
  category: string;
  brand: string;
  name: string;
  shade?: string;
  section: "necessary" | "optional";
  title: string;              // 淘宝商品标题
  image?: string;             // 只取第一张
  price?: string;             // 淘宝挂牌价字符串，不做数值换算
  shop?: string;
  purchaseUrl: string;        // 商品详情链接，必填；没有就不出这张卡
  detailLevel: "detail" | "search";  // 图/链接来自详情接口还是搜索回退
};

/** SSE 事件体：渐进式发出，前端按 id 合并。 */
export type ProductCardsEvent = {
  phase: "pending" | "items" | "done";
  expected?: number;                          // pending：本轮共几件要补全
  categories?: string[];                      // pending：骨架卡上的品类文字，顺序与商品清单一致
  items?: ProductCard[];                      // items：本次解析出的卡片
  failed?: { brand: string; name: string; reason: string }[];
  status?: "ok" | "partial" | "unavailable";  // 仅 done 时给
};

/** 合并后存进 turn（并随对话进 localStorage）的结果。 */
export type ProductCardsState = {
  status: "pending" | "ok" | "partial" | "unavailable";
  expected: number;
  categories: string[];   // 骨架卡按它对号入座
  items: ProductCard[];
  failed: { brand: string; name: string; reason: string }[];
};
```

事件名 `product_cards`，同样经 `formatSseEvent`，按 `phase` 分三次发出：

1. **`pending`**——`result` 之后立刻发，只带 `expected` 和 `categories`（都在服务端算好，不需要淘宝）。前端据此渲染 N 张骨架卡，用户在淘宝请求还在飞的时候就知道有几件商品要来。
2. **`items`**——每件商品解析出结果就发一次，`items` 只带本次新增（同 `id` 再次出现表示覆盖升级）。
3. **`done`**——全部结束（含超预算或被中断的）时发一次，带 `status` 和 `failed`。

之所以渐进而不是攒一批：上游是采集类接口，官方建议超时 120s（SSOT 第 5 节），攒批会让用户盯着空白条等几十秒。**payload 只含白名单字段**，不透传上游原始响应（第 10 节）。

### 6.4 前端类型与持久化

- `frontend/lib/types.ts`：`Turn` 增加 `cards?: ProductCardsState`（`import type` 自 `lib/commerce/types.ts`，该文件只有类型、无运行时依赖，可被客户端安全引用）。
- 卡片随 turn 存进 localStorage（`useConversations`）——只存 URL 不存图片数据，一条 8 卡的状态约 4 KB。

## 7. 选品与匹配规则（确定性）

对块里的每一条：

1. **搜索词** = `[brand, name, shade]` 去空后以空格连接，压缩连续空白，去掉首尾标点；长度上限 60 字。
2. **选中商品**：先跳过 `item_id` 缺失的非商品卡片和 `isP4p === "true"` 的广告位（实测 46 条商品里 4 条是 P4P，我们的卡片是「首选商品」展示位，不拿广告顶）；剩下取**标题包含品牌名**（大小写、空格、全角半角归一化后比较）的第一条，前 3 条都不含品牌名时取第一条。整页全是广告位时退而取第一条广告——仍是可购买商品，比不出卡强，但要靠这个顺序保证正常页面永远优先自然结果。同一条规则、可测试、不引入排序模型。
3. **图片**：详情接口的 `images[0]`（即上游 `item_imgs[0]`，SSOT 6 节）。详情失败时回退搜索结果的 `picUrl`，卡片标 `detailLevel: "search"`；两者都没有就出无图卡片，**不换商品、不用别的图凑**。
4. **链接**：优先用详情接口的 `detail_url`。详情失败时用搜索的 `item_id` 拼 `https://item.taobao.com/item.htm?id={item_id}`——这是该商品的规范详情页地址（不是搜索结果页），同样标 `detailLevel: "search"`。连 `item_id` 都没有才不出卡并计入 `failed`。任何情况下不允许用 `s.taobao.com/search?q=` 或广告位 `auctionURL` 充当商品链接。
5. **价格**：详情 `price` 优先，回退搜索 `price`；有就显示并标注「价格与库存以淘宝页面为准」，没有就不显示。绝不编价。
6. **并发与预算**：并发 2，单请求超时 30s，整批总预算 60s（依据见 SSOT 第 5 节：这是采集类接口，官方建议超时 120s，按普通 REST 的秒级超时会大面积失败）。超预算的商品按失败处理，已经拿到的卡片照常发出（`status: "partial"`）。遇到 `302`／`303`／`601`／`602`（限流、配额、余额）**立即停止本轮剩余请求**：重试只会继续烧配额。
7. **缓存**：key 为归一化 `brand|name|shade`，缓存已解析的卡片（不是上游原始响应），TTL 默认 24 小时，写在 `.local-data/taobao-cards.json`（复用 `lib/storage/json-store.ts`）。命中的卡片不再发请求。

## 8. 前端

### 卡片条 `frontend/components/chat/ProductCardStrip.tsx`

- 位置：助手轮次内、`AdvisorMessage` 之下（`TurnTrace` → 答案 → 卡片条），只在该轮有卡片时渲染。
- 骨架态：收到 `phase: "pending"` 就按 `expected` 渲染 N 张骨架卡（图片位用 `ui/skeleton`），品类文字用同一条事件带下来的 `categories`（服务端已知，不需要等淘宝）；`items` 到达时按顺序替换对应骨架。
- 合并规则：`items` 按 `id` 合并（同 id 覆盖、新 id 追加，保持首次出现顺序），`failed` 累加，`done` 落最终 `status`。合并写成纯函数 `mergeProductCards(state, event)` 放 `frontend/lib/product-cards.ts`，由 `useChat` 调用（跟 `frontend/lib/sse.ts` 一样可被 L1 直接测）；组件只渲染合并后的状态。
- 结构：标题行「需要购买的首选 · 共 N 件」＋右侧小字「价格与库存以淘宝页面为准」；下面是横向滚动容器 `flex gap-4 overflow-x-auto snap-x snap-mandatory scrollbar-thin`，每张卡 `snap-start shrink-0 w-[210px] sm:w-[240px]`。
- 桌面（`md+`）在容器两侧显示左右箭头按钮，一次滚动一卡（`scrollBy`）；移动端原生滑动。
- 单卡：1:1 图片（`object-cover`、`loading="lazy"`、`referrerPolicy="no-referrer"`、`onError` 落成占位块）→ 品类徽章与「核心／按需」标 → 品名（两行截断）→ 品牌 · 色号 → 价格 → 「去淘宝」按钮。
- 链接一律 `<a target="_blank" rel="noreferrer noopener nofollow">`，不新开窗口以外的副作用。
- 全部失败/未配置凭据时不渲染空卡片条，只留一行说明（第 9 节）；`status === "partial"` 时在末尾补一张「其余 N 件暂未取到」的说明卡。
- 无障碍：容器 `aria-label="可在淘宝购买的首选商品"`，图片 alt 用商品标题，箭头按钮有 `aria-label`。

### 流式阶段隐藏块

- `useChat` 累积 `text_delta` 时套用 `stripProductBlock()`（`lib/commerce/product-block.ts` 的纯函数，服务端与前端共用同一实现），保证块在流式过程中也不会以原始 JSON 出现。
- `result` 到达后 `assistantTurn.text` 用的是服务端已剥离的正文，两者一致。

### 答案落地后不再锁住界面

`product_cards` 在 `result` 之后到达，最长要等一整轮淘宝预算（默认 60s）。这一段时间里本轮已经是可用的：

- `useChat` 收到 `result` 就把 `isSending` 置回 false（流仍然开着继续收卡片事件），输入框立刻可用；否则用户会被一个「还在生成」的输入框按住一分钟。
- `ChatView` 的 `isStreaming` 改为 `isSending && index === turns.length - 1 && !turn.answer`，「本轮过程」面板在答案落地时收起，而不是等淘宝。

## 9. 失败与降级

| 情况 | 行为 |
| --- | --- |
| 技能没输出块，或块不合法 | 不发 `product_cards`；答案照常；服务端记一条原因（不含 token、不含上游 URL） |
| 未配置 `TAOBAO_API_TOKEN` | 不发任何请求，连 `pending` 都不发；UI 不出现任何假价格、假链接 |
| 搜索无结果 / 结果里没有可用条目 | 该商品不出卡，进 `failed` |
| 详情失败、超时、`code` 非 0 | 回退搜索结果的主图与拼出的商品链接，`detailLevel: "search"` |
| `301` / HTTP 5xx / 网络超时 | 重试一次；仍失败则按「详情失败」回退 |
| `302` / `303` / `601` / `602`（限流、配额、余额） | **立即停止本轮剩余请求**；已出的卡片保留；`status: "partial"`，卡片条补一行「本轮淘宝查询额度受限」 |
| `100` / `600`（token 失效、权限不足） | 整批停止，表现同「未配置」，同时把 `requestId` 记进服务端日志 |
| 单件失败 | 其余卡片照常（`status: "partial"`） |
| 全部失败 | 只渲染一行「淘宝商品信息暂不可用，可点表格里的商品名自行搜索」 |
| 超出总预算（60s） | 已完成的先发；其余计入 `failed`，`status: "partial"` |
| 用户中断（abort） | 停止补全，不发 `done` |

## 10. 隐私与边界

- 卡片 payload 只含 `ProductCard` 的白名单字段；上游响应里的 cookie、`access_token`、签名、原始 JSON 一律不转发、不落盘、不进日志。
- 商品清单**不进入模型上下文**：块由技能在答案里产出后被服务端消费，服务端不会把淘宝结果回灌给模型。
- `TAOBAO_API_TOKEN` 已在 `lib/pi/events.ts` 的 `SECRET_ENV_KEY` 脱敏范围内；又因为它在 query string 里，**完整请求 URL 不能进日志、错误信息和异常文本**（SSOT 第 7 节）。
- 卡片事件与服务端日志都不带上游的诊断字段（搜索结果里的页内状态、详情里的 `desc` HTML、`url_log`、`_ddf`）。
- 淘宝链接是给用户点的商品详情链接，不参与前端埋点，不带站内 token。

## 11. 配置

`.env.example` 新增（鉴权只有 `token` 一个参数，详见 SSOT 第 7 节）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TAOBAO_API_BASE_URL` | `https://api.justoneapi.com` | 换供应商或指向沙箱时才改 |
| `TAOBAO_API_TOKEN` | 空 | 唯一凭据，走 query 参数；为空即视为未配置 |
| `TAOBAO_API_TIMEOUT_SECONDS` | 30 | 单请求超时 |
| `TAOBAO_CARDS_BUDGET_SECONDS` | 60 | 整批总预算 |
| `TAOBAO_CARD_LIMIT` | 8 | 单轮卡片上限（也是块条目上限） |
| `TAOBAO_CACHE_TTL_SECONDS` | 86400 | 卡片缓存 TTL |

原方案里的 `TAOBAO_API_MODE=mock`（无凭据时用 fixture 看 UI）**没有实现**：写这份 spec 时 token 已经配好，真实链路可以直接跑，多一条假数据分支只会多一个上线前要拆的东西。需要它的时候再加。

`.env` 里遗留的 `TAOBAO_API_KEY` / `TAOBAO_API_SECRET`（旧的占位代码留下的空值）已删掉：本平台不用 key/secret，留着只会让人以为配了就生效。

## 12. 测试计划

**L1（`npm run test:l1`，全部不发真实请求）**

- `test/L1/product-block.test.ts`：合法块提取 + 正文剥离；非法 JSON／版本不符／字段为空时不出条目但**仍剥离**；多个块合并去重；超上限截断；按 `brand|name|shade` 去重；`stripProductBlock` 对流式半截文本的处理。
- `test/L1/taobao-cards.test.ts`（注入 `fetchImpl`，数据用 SSOT 第 9 节两个示例裁剪出的 fixture）：搜索→选品→详情→卡片字段映射；标题去 `<span class=H>` 标签；`uprightImg` 缺失时回退 `pic_path` 并把 `http:` 升级为 `https:`；跳过非商品卡片与 `isP4p: "true"` 的广告位；品牌命中优先规则；只为详情失败的商品回退搜索图与 `item.htm?id=` 链接并标 `detailLevel: "search"`；`code !== 0` 时不产生编造字段；`301` 重试一次、`302`/`303`/`601`/`602` 立即停止剩余请求；并发上限与总预算；缓存命中不发请求；未配置 token 时 `configured === false` 且零请求。
- `test/L1/frontend-runtime.test.ts`：`Turn.cards` 类型契约；`mergeProductCards` 的追加、按 id 覆盖、`failed` 累加与 `done` 落状态。

**L3（`RUN_L3_E2E=1`）**

- 扩展 `test/L3/pi-skill.e2e.test.ts`：断言真实 pi 进程读到的技能文本包含 `looktrace-products` 契约与 `looktrace.products.v1`（用 mock 模型跑，不烧真实额度）。
- 「真实模型会不会真的产出合法块」不适合放进日常测试（要真实模型 + 小红书），靠第 13 节那一次真实请求验证。

**真实链路**

配好 `TAOBAO_API_TOKEN` 后跑一次真实妆容请求：答案里有拆解表，下面有卡片条，卡片是淘宝商品图、点「去淘宝」进商品详情页；正文和历史记录里都不出现机器可读块。

## 13. 验证记录

验证时间 2026-09-21，`TAOBAO_API_TOKEN` 为真实 token。

**上游实测**

| 项 | 结果 |
| --- | --- |
| 搜索 V2 单次调用 | `code=0`，10.3s / 8.5s / 6.2s / 3.9s（同一关键词重复打也有差异） |
| 详情 V3 单次调用 | `code=0`，3.4s |
| 搜索页 `uprightImg` | 抽样 4 条商品**全是 `null`**，图片实际都靠 `pic_path` 回退——回退分支是主路径而不是兜底 |
| 广告位 | 46 条商品里 4 条 `isP4p=true`，其中一条正是首位结果 |
| `code=301` | 关键词相关且偶发：`MAC 口红 Chili` 连续失败，`MAC 子弹头口红 Chili` 与 `魅可 子弹头口红 Chili` 正常返回 46/48 条；上游 message 就是 `COLLECT FAILED, SEND REQUEST AGAIN` |
| 图片直连 | `img.alicdn.com` 图片带空 Referer 请求返回 200 `image/webp`，`referrerPolicy="no-referrer"` 可以正常显示 |
| 商品链接 | `item.taobao.com/item.htm?id=…` 返回 200 |

**补全链路（真实 token，3 件商品）**

`buildProductCards` 跑通 2 张卡片、1 件因 `code=301` 失败，总耗时 40.9s，`status: "partial"`。卡片字段全部来自淘宝：图 `img.alicdn.com/…jpg`、价 `17.90`、店铺 `Bymi美妆集合店`、链接 `item.taobao.com/item.htm?id=1004620982324`、`detailLevel: "detail"`。

**端到端（`next dev` + 真实 pi + 真实小红书 MCP + 真实 token）**

请求 `{"message":"韩系氧气妆"}`，一轮 41 次工具调用、24 次模型调用、约 16 分钟：

| 检查项 | 结果 |
| --- | --- |
| `result` | `status: "succeeded"`，正文 5003 字，含「必要／非必要」两张表、18 处 `💰` |
| 块 | 模型**确实输出了** `looktrace-products` 块；`result` 正文里已无该块，流式正文里也没有（`stripProductBlock` 生效） |
| 事件序列 | `pending(8)` → 8 × `items` → `done(status: "ok")`，与第 6.3 节完全一致 |
| 卡片 | 8 张（等于 `TAOBAO_CARD_LIMIT`），**0 件失败**；每张都有淘宝商品图和 `item.taobao.com/item.htm?id=…` 链接 |
| 详情回退 | 其中 1 张（NARS 粉底液）`detailLevel: "search"`：详情调用失败，卡片按设计回退搜索主图与 `item_id` 拼出的详情页 |
| 图片可加载 | 8/8 返回 `200 image/webp|png`（空 Referer 直连，`referrerPolicy="no-referrer"` 有效） |
| 链接可达 | 8/8 返回 `200` |
| 缓存 | `.local-data/taobao-cards.json` 写入 8 条，键形如 `柏瑞美|黄油妆前乳|` |
| 前端渲染 | 用渲染环境把卡片条渲染成真实 DOM 核对：卡片含 `<img src="https://img.alicdn.com/…">`、`<a href="https://item.taobao.com/item.htm?id=…" rel="noreferrer noopener nofollow">`、`aria-label`、`alt`；`pending` 态渲染 2 张骨架（品类文字正确）；`partial` 补一行说明；`unavailable` 只留一行提示 |

**代码检查**

`npm run typecheck` 通过；`npm test` 36 项（35 过 1 跳过，跳过的是需要 `RUN_L3_E2E=1` 的 L3）；`RUN_L3_E2E=1 npm run test:l3` 通过（新增断言：技能里的 `looktrace-products` 契约确实进了模型上下文）；`npm run build` 通过。

## 14. 待确认

1. **「非必要」表的 `💰` 首选是否进卡片**：当前方案是进（用 `section` 区分并打「按需」标）。若只想推核心清单，改成只收 `necessary` 即可。
2. **详情接口用 V3 还是 V6**：当前按 V3——字段平铺、直接给 `detail_url`，映射成本最低。V6 是供应商标为推荐的版本，带券后价和运费，但是原始 H5 嵌套结构、没有 `detail_url`。要券后价就换 V6，改动只在映射层（SSOT 第 4.3 节）。
3. **卡片上限 8、缓存 24h、整批预算 60s**：按你的配额与计费预期确认；每件商品 2 次调用，一轮 8 件 = 16 次（SSOT 第 8 节）。实测单件约 4–20s，预算会被长清单吃掉，商品多时靠渐进事件先给用户看。
4. **`code=301` 的重试次数**：现在是「重试一次」（共 2 次尝试）。实测它偶发且上游自己建议重试，如果觉得卡片缺件比等待更糟，可以加第 3 次尝试——代价是预算内少补一件商品。
5. 接口格式本身没确认的项（天猫商品在 V3 下的字段差异、搜索每页条数、QPS 上限）记在 SSOT 第 10 节，不在这里重复。
