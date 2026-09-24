# Just One API 淘宝接口 SSOT

Status: verified against the provider's live docs, response examples, and real calls with our token
Date: 2026-09-21（2026-09-24 详情 V3 → V8 → V6，见第 4.3 节）
Related specs: [09-21-taobao-product-cards.md](./09-21-taobao-product-cards.md)（消费方） · [001-mvp.md](./001-mvp.md)

## 0. 文档目的

本文是「我们怎么调淘宝中转站」的唯一事实来源：接口路径、鉴权、参数、响应字段、错误码、超时和映射规则只在这里定义一次，代码里只允许有**一处**实现（`lib/commerce/taobao.ts`）。其它文档和注释引用本文，不复述字段名——字段写错一次就到处错。

供应商是 **Just One API**，不是淘宝开放平台，也不是浏览器驱动/自建采集那类服务（小红书链路曾经用过后者，已删除，见 [09-24-xhs-api-integration.md](./09-24-xhs-api-integration.md)）。

## 1. 接入点与鉴权

| 项 | 值 |
| --- | --- |
| 文档站 | `https://docs.justoneapi.com` |
| Base URL | `https://api.justoneapi.com`（OpenAPI `servers` 的「全球生产 API（默认）」） |
| 鉴权 | **查询参数 `token`**，无签名、无 key/secret、无 header |
| 传输 | 全部 GET，无请求体 |
| 本项目用到的端点 | 商品搜索 V2、商品详情 **V6** |

平台共有 302 个端点用 query token、13 个用 body token；本项目只用下面两个，两个都是 query token。

## 2. 端点

### 2.1 商品搜索 V2

```text
GET {BASE}/api/taobao/search-item-list/v2?token={TOKEN}&keyword={关键词}&page={页码}
```

| 参数 | 位置 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `token` | query | 是 | — | 访问令牌 |
| `keyword` | query | 是 | — | 搜索关键词 |
| `page` | query | 否 | `1` | 页码，从 1 开始 |

按**销量**排序返回。实测响应里 `data.mainInfo` 为 `{"page":"1","pageSize":"48","order_by":"_sale","paramValue":"衣服"}`：一页 48 条，`order_by` 固定 `_sale`。

### 2.2 商品详情 V6

```text
GET {BASE}/api/taobao/get-item-detail/v6?token={TOKEN}&itemId={商品ID}
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `token` | query | 是 | 访问令牌 |
| `itemId` | query | 是 | 商品 ID，取自搜索结果条目的 `item_id` |

一次只接一个 `itemId`：批量靠调用方循环，上游没有批量参数。入参与 V8 完全一致，换版本只改路径和映射层。

文档把 V6 标为**推荐**（OpenAPI 的 `x-recommended: true`），并列出三项 V8 没有的能力：预估销量、运费（是否包邮）、**部分商品的券后价**。

## 3. 响应信封（两个端点一致）

```json
{ "code": 0, "message": null, "data": { }, "recordTime": null, "requestId": "..." }
```

- **先判 `code`，再看 `data`**：HTTP 200 也可能是业务失败；HTTP 4xx/5xx 的响应体同样是这个信封。
- `code === 0` 才是成功；失败时 `data` 无意义。
- `message`／`recordTime`／`requestId` 在实际响应里**可能缺失**（实测示例里 `requestId`、`recordTime` 都是 `null`），不能按必填处理。
- `requestId` 是供应商侧的排障 ID：出错时记进服务端日志（它不是敏感信息），但不进客户端 payload。

### 业务码

| code | 含义 | 我方处理 |
| --- | --- | --- |
| 0 | 成功 | 正常映射 |
| 100 | Token 无效或已失效 | 整批停止，不重试；记日志提示检查 `TAOBAO_API_TOKEN` |
| 101 / 202 / 300 / 404 / 503 | 枚举里有、文档未给含义 | 当未知失败，不重试 |
| 301 | 采集失败，请重试 | 重试一次，仍失败则放弃该商品 |
| 302 | 超出速率限制 | **瞬时错**：退避后重试一次，本轮剩余请求降并发到 1；仍失败只算这一件（见第 8.3 节） |
| 303 | 超出每日配额 | 整批停止 |
| 400 | 参数错误 | 放弃该商品（多半是关键词过长或非法字符） |
| 500 | 内部服务器错误 | 重试一次，仍失败则放弃该商品 |
| 600 | 权限不足 | 整批停止 |
| 601 | 账户余额不足 | 整批停止 |
| 602 | TOKEN 限额超限 | 整批停止 |

HTTP 层另有 `400 / 401 / 403 / 429 / 500 / 503`，与上面的业务码并存；不同 HTTP 状态也可能带同一个 `code`。**判据只有 `code`**。

## 4. `data` 的形状

### 4.1 搜索 V2：`data.itemsArray[]`

整页搜索页状态，实测约 **320 KB**，绝大多数是页面内部字段。我们只读 `itemsArray`：

| 上游字段 | 类型 | 说明 |
| --- | --- | --- |
| `item_id` | string | 商品 ID，详情接口的入参 |
| `title` | string | 标题；**可能含 `<span class=H>关键词</span>` 高亮标签，必须去标签** |
| `uprightImg` | string | 竖版主图，`https://` 绝对地址；实测 46 条里 3 条缺失 |
| `pic_path` | string | 主图，可能是 `http://`（混内容），**必须升级到 https** |
| `price` | string | 价格字符串，可能是空串 |
| `nick` | string | 卖家昵称 |
| `shopInfo.title` | string | 店铺名 |
| `procity` | string | 发货地 |
| `realSales` | string | 销量文案（如 `4000+人收货`、`本月行业热销`），**不是数字** |
| `isP4p` | string | `"true"` 表示广告位；实测 46 条里 4 条为 `"true"` |
| `auctionURL` | string | **广告点击跟踪链接**（`click.simba.taobao.com/cc_im?...`），**禁止当商品链接使用** |

- **没有 `detail_url`**：搜索结果不给商品详情页地址，链接只能来自详情接口，或由 `item_id` 拼 `https://item.taobao.com/item.htm?id={item_id}`。
- `itemsArray` 里混有**非商品卡片**（实测 49 条中 3 条只有 `customCard` / `customCardType` / `recommendQueryItemList`，没有 `item_id`）：跳过。
- `data` 里其余字段（`_cost`、`_host`、`cardStyle`、`iconStyle`、`filterMod*`、`p4pData`、`pcNewFeedback`、`pvid`、`scm`、`tpp_buckets`、`tpp_trace`、`utLogMap`、`umpPriceLog`、`extraParams`、`ifsUrl`…）是页面内部状态和跟踪参数：**不映射、不落盘、不转发、不进日志**。
- `data.result` / `data.itemsArrayRec` 在实测样本里是空数组，不要依赖。

### 4.2 详情 V6：`data`

**嵌套结构**（V3/V8 都是平铺），顶层 7 个键：`item` / `seller` / `skuBase` / `skuCore` / `status` / `tid` / `delivery`。我们用到的：

| 上游字段 | 类型 | 说明 |
| --- | --- | --- |
| `item.itemId` | **string** | 商品 ID。**V6 回字符串**（V8 回数字），映射层统一成字符串 |
| `item.title` | string | 标题（纯文本，无高亮标签）。V6 **没有** `title_cn` |
| `item.price` | string | 现价字符串，如 `"78"`；**可能是空串** |
| `item.couponPrice` | string | 券后价，**只有部分商品有**，没有时是空串 |
| `item.originalPrice` | string | 原价（V8 的拼写错字 `orginal_price` 在 V6 里没有了） |
| `item.images[]` | array | 商品主图组，**元素是 https 裸地址字符串**；样例 5 张，`images[0]` 就是主图 |
| `item.detailImages[]` | array | 详情长图组，样例 19 张。**不映射**：这是详情页里的图，不是卡片要的主图 |
| `seller.shopName` | string | 店铺名 |
| `skuBase.skus[]` / `skuBase.props[]` | array | SKU（`skuId` / `propPath`）与规格维度。本次不用 |
| `status` / `tid` / `delivery` / `skuCore` | — | 在售状态、商品 ID（与 `item.itemId` 同值）、运费、SKU 库存。本次不用 |

- **没有 `detail_url`**：V6 不给商品详情页地址，卡片链接由 `itemId` 拼 `https://item.taobao.com/item.htm?id={itemId}`——消费方 spec 第 7 节本来就允许这条路（`lib/commerce/cards.ts` 的 `itemUrl()`）。这是 V3/V8 → V6 唯一**少**的东西。
- `item.images[]` 的元素是裸地址字符串，和 V8 的 `item_imgs[]` 一样**两种形状都过 `normalizeUrl`**（它同时收协议相对和 `http:`）；`pic_url` 的兜底链保留，只为接住平铺形状。
- `item.desc` 是详情 HTML（样例 1.7 KB）：**禁止转发、落盘、进日志或进模型上下文**。
- `item.attribute[]`（`{key, value}` 属性表）、`item.video*` / `categoryId` / `videoCover` 本次用不到：**不映射**。

### 4.3 详情版本的选择：为什么是 V6

版本换过两次：V3 → V8 是为**省钱**（同一账户下 V3 ¥0.6/次、V8 ¥0.2/次，一轮 8 张卡差 ¥3.2）；V8 → V6 是为**字段**——V6 是文档标记的推荐版本，且多两样 V8 给不了的东西：`delivery`（运费/是否包邮）与 `item.couponPrice`（券后价，部分商品有）。

| | V3 | V8 | **V6（选用）** |
| --- | --- | --- | --- |
| 单价 | ¥0.6 | ¥0.2 | **未核（见第 10 节）** |
| 结构 | 平铺 56 字段 | 平铺 25 字段 | **顶层 7 键：`item` / `seller` / `skuBase` / `skuCore` / `status` / `tid` / `delivery`** |
| 商品 ID | 字符串 | 数字 | **字符串（`item.itemId`）** |
| 商品链接 | 直接给 `detail_url` | 直接给 `detail_url` | **没有，要拿 `item.itemId` 自己拼** |
| 图片 | `pic_url` / `item_imgs[]`，协议相对 | https 绝对地址；`item_imgs[]` 是字符串数组 | **`item.images[]`，https 绝对地址**（另有 `detailImages` 长图，不用） |
| 价格 | `price` | `price` | **`item.price`**，空串时退 `item.couponPrice` |
| 店铺 | `nick` | `nick` | **`seller.shopName`** |
| 运费/包邮 | 无 | 无 | **有（`delivery`），本次不映射** |

**代价要记账**：V6 的单价没核过（公开文档不给单价），而换它的初衷不是省钱。如果账单显示 V6 比 V8 贵，那就得重新算一遍——第 8.2 节的成本表会跟着变。

映射层按**嵌套优先、平铺兜底**写：每个字段先读 `item` / `seller`，读不到再读 V8/V3 的平铺名（`num_iid` / `item_imgs` / `nick` / `title_cn`）。换版本或上游回退时，卡片不会静默退化成「空标题 + 空图」——那是没有报错、只有详情全空的那种坏法。`lib/commerce/taobao.ts` 的 `imageEntryUrl()` / `itemIdOf()` 也是为同一类形状差异写的。

V6 的字段来自供应商的**官方公开示例**（`synthetic: false` 的真实抓取，商品是川川也的 T 恤），**尚未用我们的 token 在真实商品上核过**——见第 10 节。

## 5. 超时、重试与并发

| 项 | 值 | 依据 |
| --- | --- | --- |
| 官方建议超时 | 120s（至少 60s） | 文档明确写了「建议 120 秒；偏长也请至少 60 秒，否则会有少量请求收不到结果」 |
| 我方单请求超时 | 30s（`TAOBAO_API_TIMEOUT_SECONDS`） | 采集类接口，比普通 REST 慢一个量级；低于 30s 会大面积超时 |
| 我方整批预算 | 60s | 到期即停止后续请求，已拿到的卡片照发 |
| 每商品请求数 | 2（搜索 1 + 详情 1） | 顺序调用：先搜索定位 `item_id`，再详情取图与链接 |
| 并发 | 2 | 平台未公布 QPS；限流码 302 出现即降并发 |
| 重试 | 301、HTTP 5xx、网络超时各立刻重试 1 次；**302 退避 5s 后重试 1 次** | 303/601/602 是终态，重试只会再拿一次同样的错。302 是瞬时的，而失败的调用不计费（第 8.1 节），所以这次退避只花时间、不花钱 |

结论写进设计取向：**宁可少出几张卡片，也不让答案等着淘宝**（见消费方 spec 的渐进式事件）。

## 6. 映射到内部类型

这是唯一的映射表；`lib/commerce/taobao.ts` 之外的代码只知道右侧的内部类型。

| 内部字段 | 上游来源 | 规则 |
| --- | --- | --- |
| `TaobaoSearchItem.numIid` | `search.itemsArray[].item_id` | 缺失即跳过该条目 |
| `TaobaoSearchItem.title` | `.title` | 去 HTML 标签、压缩空白 |
| `TaobaoSearchItem.picUrl` | `.uprightImg` → `.pic_path` | `http:` 升级为 `https:` |
| `TaobaoSearchItem.price` | `.price` | 空串按缺失处理 |
| `TaobaoSearchItem.shop` | `.shopInfo.title` → `.nick` | |
| `TaobaoSearchItem.isP4p` | `.isP4p` | 只做布尔标记，选品规则由消费方决定；`auctionURL` **不映射** |
| `TaobaoItemDetail.numIid` | `item.itemId` → `detail.num_iid` | 数字或字符串都收（V6 回字符串、V8 回数字）；缺失时退回请求里的 `itemId` |
| `TaobaoItemDetail.title` | `item.title` → `detail.title` → `detail.title_cn` | 三者都空才算缺失 |
| `TaobaoItemDetail.images` | `item.images[]` → `detail.item_imgs[]` → `[detail.pic_url]` | 元素是裸地址字符串（V6/V8）或 `{url}`（V3），两种都收；每个 URL 补 `https:`；**消费方只取 `[0]`** |
| `TaobaoItemDetail.price` | `item.price` → `item.couponPrice` → `detail.price` | 原样字符串，不做数值换算；**券后价只在现价空串时才顶上**，不然挂出来的价和商品页对不上 |
| `TaobaoItemDetail.detailUrl` | `detail.detail_url` | 卡片链接的正规来源。**V6 没有这个字段**，值留空由消费方按 `itemId` 拼（消费方 spec 第 7 节） |
| `TaobaoItemDetail.shop` | `seller.shopName` → `detail.nick` | |
| 诊断 | `requestId` / `recordTime` / `code` / `message` | 只进服务端日志。V6/V8 没有 V3 的 `error` / `warning` / `url_log` |

## 7. 凭据与脱敏

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TAOBAO_CARDS_ENABLED` | `false` | 消费方侧的总开关，**默认关**：上游按次计费，打开才发请求（见消费方 spec） |
| `TAOBAO_API_BASE_URL` | `https://api.justoneapi.com` | 换供应商或指向沙箱时才改 |
| `TAOBAO_API_TOKEN` | 空 | 为空即视为「未配置」：**不发任何请求**，功能整体降级（见消费方 spec） |
| `TAOBAO_API_TIMEOUT_SECONDS` | `30` | 单请求超时 |

- `.env` 里遗留的 `TAOBAO_API_KEY` / `TAOBAO_API_SECRET` 是旧占位代码留下的，本平台不用 key/secret：**删除**，避免误以为生效。
- token 走 **query string**：完整 URL 会带 token，**禁止把完整 URL 写进日志、错误信息、SSE 事件或异常堆栈**。日志只写 `path` + `requestId`。
- `lib/pi/events.ts` 的 `SECRET_ENV_KEY`（`API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL`）已覆盖 `TAOBAO_API_TOKEN`，工具结果与文本增量会被脱敏。
- 进客户端的东西只有消费方 spec 定义的白名单字段；搜索的 320 KB 页内状态和详情的 `desc` HTML 一律不出服务端。

## 8. 配额与成本

### 8.1 只有成功计费

供应商的「API 使用指南」给了每个业务码的**是否计费**，结论和直觉相反：

| code | 含义 | 计费 |
| --- | --- | --- |
| 0 | 成功 | **是** 💰 |
| 100 / 301 / 302 / 303 / 400 / 500 / 600 / 601 / 602 | 各类失败 | **否** |

推论，写下来免得再算错一遍：

- **重试不是成本来源**。`lib/commerce/cards.ts` 的 `withRetry` 在 301、HTTP 5xx、网络超时上各重试一次——这些失败都不计费。只有「第一次失败、第二次成功」才真正产生费用，而且只记成功那一次。所以重试策略不用为了省钱而收紧。
- **成本 = 成功调用次数 × 单价**。失败、超时、限流都不烧钱，但它们也不交付卡片。
- **每日限额同样只统计 `code=0` 的成功请求**（按 Asia/Shanghai 自然日，账户下所有 TOKEN 合并计数）。超限返回业务码 `303` + HTTP `429`，超限请求不计费。
- 平台**没有通用速率限制**；单价只在登录后的系统里能看，公开文档不给。

### 8.2 一轮妆容的成本

一轮（`TAOBAO_CARD_LIMIT` 默认 8）= **8 次搜索 V2 + 8 次详情 V6 = 16 次成功调用**：

| 项 | V3 时期 | V8 时期 | **V6（现在）** |
| --- | --- | --- | --- |
| 详情 8 次 | 8 × ¥0.6 = ¥4.8 | 8 × ¥0.2 = ¥1.6 | **单价未核（见下）** |
| 搜索 8 次 | 单价未核（见下） | 不变 | 不变 |
| 每轮合计 | 约 ¥9（实测账单） | 约 ¥5.8 | **待账单核对** |

**详情 V6 与搜索 V2 的单价都尚未核实**：公开文档不给单价，我们的账单又是两个端点混在一起的。V8 的 ¥0.2 是登录系统里看过的，V6 没有这一手数据——**换到 V6 之后要重新按 endpoint 对一次账**，否则「省钱」这个前提就是空的。

**搜索 V2 的单价尚未核实**：公开文档不给单价，我们的账单又是两个端点混在一起的。按实测的约 ¥9/轮反推，搜索约 ¥0.5/次——和详情同属最贵的那一档。对账方法是登录系统看「接口调用记录 / 消费金额分析」，按 endpoint 分开统计。**这个数字值得先核**：如果搜索确实约 ¥0.5/次，那么「一轮 16 次调用」里搜索占的 ¥4 才是最大的一块，而它现在每张卡都要打一次。

成本与条数线性相关，三个杠杆按省下多少排序：

1. **换更便宜的详情版本**（做过一次：V3 → V8，每轮 −¥3.2；V8 → V6 是换字段不是换价钱，**单价要重新核**）。
2. **少调详情**：搜索结果本身已经给了 `item_id`、主图、价格、店铺，够拼出一张卡（`detailLevel: "search"` 那条路径）。代价是标题会被搜索引擎截断（实测出现「…小个子宽松上」这种半截）、主图是竖版缩略图、价格可能是空串。
3. **降 `TAOBAO_CARD_LIMIT`**：成本线性减半，代价是每轮有卡片的商品变少。

缓存（第 5 节 / 消费方 spec 第 7.7 节）是唯一不牺牲卡片质量的路子：TTL 24h，命中的卡片一次请求都不发。注意 `productKey` 只做小写化与空白压缩，**不归一化标点与全角半角**——技能换一种写法描述同一件商品（`持久眼线胶笔` vs `持久眼線膠筆`），键就变了，缓存穿透、重新计费。加别名归一化前，先用第 8.2 节的调用记录确认穿透是否真的发生。

### 8.3 停止条件

出现 `303` / `601` / `602` 时**立即停止本轮剩余请求**——这些是终态错，继续打下去只会拿到同样的错，而成功的那几次才烧钱。

**`302` 不在此列**，处置与第 3 节那张表一致：退避后重试一次，并把本轮并发降到 1；仍失败只算这一件。它不是配额耗尽——上游只在「用户 × 接口」配了速率（每分钟/每小时）时才返它，窗口过了自己会好；把它当 303 处理，等于让一次瞬时抖动吃掉整批卡片。这不是假设：2026-09-24 的一次真实请求里，兰蔻那件详情撞上 302，整批 8 件商品中的 6 件连请求都没发出去（Langfuse trace `9861b951415096f53d286853bbed9f55`）。

阈值只写一处：`lib/commerce/taobao.ts` 的 `QUOTA_ERROR_CODES`（303/601/602）与 `RATE_LIMIT_ERROR_CODES`（302），以及 `lib/commerce/cards.ts` 的 `DEFAULT_RATE_LIMIT_BACKOFF_MS`。

## 9. 怎么核对本文没写错

1. OpenAPI 定义（字段和参数以它为准）：
   - `https://docs.justoneapi.com/openapi/taobao-and-tmall/product-search-v2-zh.json`
   - `https://docs.justoneapi.com/openapi/taobao-and-tmall/product-details-v6-zh.json`
   - 注意：OpenAPI 里 `data` 是**无 schema 的空对象**，字段名只能靠响应示例和真实调用核对，定义文件本身帮不上。
2. **真实响应示例（不需要 token）**——本文第 4 节的字段就是这么核对的：

```bash
curl -G --data-urlencode "api=/api/taobao/search-item-list/v2" \
  https://api.justoneapi.com/status/api-example/detail
curl -G --data-urlencode "api=/api/taobao/get-item-detail/v6" \
  https://api.justoneapi.com/status/api-example/detail
```

计费规则（第 8 节）来自使用指南：`https://docs.justoneapi.com/zh/usage` 的「响应处理与错误码」表里有「是否计费」一列，接口目录在 `https://docs.justoneapi.com/zh/api/taobao-and-tmall/`（V1–V9 都在，公开文档不给单价）。

返回 `{code, data:{api, checkedAt, synthetic, example:{...真实响应...}}, message}`；`synthetic: false` 表示是真调用抓下来的样本。文档站页面上的「响应示例」就是用它渲染的，所以这两条命令能拿到的信息比页面正文多。

3. L1 测试用上面两个示例裁剪出的 fixture（去掉页内字段，保留 2–3 条真实条目）做映射回归；字段改名时先改本文，再改 fixture，再改实现。

2026-09-21 用真实 token 核对的结果（调用耗时、`code=301` 的触发条件、`uprightImg` 实测全空、图片直连与商品链接可达性）记在 [09-21-taobao-product-cards.md](./09-21-taobao-product-cards.md) 第 13 节。

## 10. 未确认

1. **详情 V6 尚未用我们的 token 真调过**。V6 的字段形状来自供应商的官方公开示例（`synthetic: false`，是真抓下来的样本，商品是川川也的 T 恤），不是我们自己的调用。换成 V6 后的第一次真调要看着这几件事：`code=0`、`item.itemId` 是字符串、`item.images[]` 非空且是裸地址、`item.title` 非空（没有 `detail_url` 是预期内的，别当故障）。回归 fixture 也来自这个公开示例（`test/L1/fixtures/taobao-detail-v6.json`），因此它与搜索 fixture **不是同一件商品**。
2. **详情 V6 的单价**：换版本的理由是字段不是价钱，而 V6 的单价公开文档不给、我们也没看过（V8 的 ¥0.2 是登录系统里看过的）。**第一次对账要确认 V6 没有比 V8 贵**，否则第 8.2 节的整张成本表要重算——这是本次切换最大的一笔未知。
3. **详情 V6 对天猫商品**：公开示例是淘宝商品，天猫商品在 V6 下的字段差异待实测（V8 时期同样没核过）。
4. **搜索 V2 的单价**：公开文档不给单价，我们也没有按端点拆开看过账单。第 8.2 节反推的「约 ¥0.5/次」需要用系统的调用记录核实——这是目前最大的一笔不确定成本。
5. **搜索每页条数与卡片混排比例**：只观测到 1 页 48 条 + 3 张非商品卡片，未验证是否稳定。
6. **QPS 与并发上限**：平台文档只给建议超时，没有公开速率数字；并发 2 是保守取值，实测到 `302` 再下调。
7. **`total_sold` / `sales` 的口径**：未验证是 30 天还是累计，卡片上暂不展示。V6 的 `delivery`（运费/包邮）与 `item.couponPrice` 已映射进来但**尚未展示**，要用先核口径。
