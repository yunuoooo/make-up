# Just One API 淘宝接口 SSOT

Status: verified against the provider's live docs, response examples, and real calls with our token
Date: 2026-09-21
Related specs: [09-21-taobao-product-cards.md](./09-21-taobao-product-cards.md)（消费方） · [001-mvp.md](./001-mvp.md)

## 0. 文档目的

本文是「我们怎么调淘宝中转站」的唯一事实来源：接口路径、鉴权、参数、响应字段、错误码、超时和映射规则只在这里定义一次，代码里只允许有**一处**实现（`lib/commerce/taobao.ts`）。其它文档和注释引用本文，不复述字段名——字段写错一次就到处错。

供应商是 **Just One API**，不是淘宝开放平台，也不是 xiaohongshu-mcp 那类浏览器驱动服务。

## 1. 接入点与鉴权

| 项 | 值 |
| --- | --- |
| 文档站 | `https://docs.justoneapi.com` |
| Base URL | `https://api.justoneapi.com`（OpenAPI `servers` 的「全球生产 API（默认）」） |
| 鉴权 | **查询参数 `token`**，无签名、无 key/secret、无 header |
| 传输 | 全部 GET，无请求体 |
| 本项目用到的端点 | 商品搜索 V2、商品详情 V3 |

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

### 2.2 商品详情 V3

```text
GET {BASE}/api/taobao/get-item-detail/v3?token={TOKEN}&itemId={商品ID}
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `token` | query | 是 | 访问令牌 |
| `itemId` | query | 是 | 商品 ID，取自搜索结果条目的 `item_id` |

一次只接一个 `itemId`：批量靠调用方循环，上游没有批量参数。

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
| 302 | 超出速率限制 | 不重试，本轮剩余请求降并发或放弃 |
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

### 4.2 详情 V3：`data`

平铺结构，实测 56 个字段。我们用到的：

| 上游字段 | 类型 | 说明 |
| --- | --- | --- |
| `num_iid` | string | 商品 ID |
| `title` | string | 标题（纯文本，无高亮标签） |
| `price` | string | 现价字符串，如 `"39.90"` |
| `orginal_price` | string | 原价（**上游拼写就是 `orginal`**，不是 `original`） |
| `nick` | string | 卖家昵称 |
| `detail_url` | string | 商品详情页（`https://item.taobao.com/item.htm?id=...`），**卡片链接的正规来源** |
| `pic_url` | string | 主图，**协议相对**（`//img.alicdn.com/...`） |
| `item_imgs[]` | array | 图组，元素形如 `{"url": "//img.alicdn.com/..."}`；实测 `item_imgs[0].url === pic_url` |
| `total_sold` / `sales` | number/string | 销量相关，未验证口径，仅留作备用 |
| `tmall` | bool | 是否天猫 |
| `props[]` | array | `{name, value}` 属性表（品牌、尺码等） |
| `skus.sku[]` | array | SKU 列表：`price` / `properties_name` / `quantity` / `sku_id` |

- `item_imgs[].url` 与 `pic_url` 都是**协议相对地址**，进 DOM 前必须补 `https:`。
- `desc` 是详情 HTML（几百 KB，内嵌跟踪 `<map>`/`<area>`）：**禁止转发、落盘、进日志或进模型上下文**。
- `error` / `warning` / `url_log` / `_ddf` 是上游诊断字段：只在服务端排障时读，不进客户端。
- `props_name` / `prop_imgs` / `props_imgs` / `property_alias` / `seller_info` / `crumbs` / `video` 等本次用不到，不映射。

### 4.3 为什么用详情 V3，而不是官方推荐的 V6

实测两个版本的 `data` 形状完全不同：

| | V3 | V6（文档标为推荐） |
| --- | --- | --- |
| 结构 | 平铺 56 字段 | 原始 H5 结构：`{seller, item, skuCore, skuBase, tid, status, delivery}` |
| 商品链接 | 直接给 `detail_url` | 没有，要拿 `item.itemId` 自己拼 |
| 图片 | `pic_url` / `item_imgs[]`，协议相对 | `item.images[]`，https 绝对地址 |
| 价格 | `price` | `item.price` / `item.couponPrice`（部分商品有券后价） |
| 店铺 | `nick` | `seller.shopName` |

本项目用 V3：字段平铺、直接给 `detail_url`，映射成本最低。若以后要券后价，换 V6 只需改映射层——`lib/commerce/taobao.ts` 外部接口不变。

## 5. 超时、重试与并发

| 项 | 值 | 依据 |
| --- | --- | --- |
| 官方建议超时 | 120s（至少 60s） | 文档明确写了「建议 120 秒；偏长也请至少 60 秒，否则会有少量请求收不到结果」 |
| 我方单请求超时 | 30s（`TAOBAO_API_TIMEOUT_SECONDS`） | 采集类接口，比普通 REST 慢一个量级；低于 30s 会大面积超时 |
| 我方整批预算 | 60s | 到期即停止后续请求，已拿到的卡片照发 |
| 每商品请求数 | 2（搜索 1 + 详情 1） | 顺序调用：先搜索定位 `item_id`，再详情取图与链接 |
| 并发 | 2 | 平台未公布 QPS；限流码 302 出现即降并发 |
| 重试 | 仅 301、HTTP 5xx 和网络超时各重试 1 次 | 302/303/601/602 重试只会继续烧配额和余额 |

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
| `TaobaoItemDetail.numIid` | `detail.num_iid` | |
| `TaobaoItemDetail.title` | `detail.title` | |
| `TaobaoItemDetail.images` | `detail.item_imgs[].url` → `[detail.pic_url]` | 每个 URL 补 `https:`；**消费方只取 `[0]`** |
| `TaobaoItemDetail.price` | `detail.price` | 原样字符串，不做数值换算 |
| `TaobaoItemDetail.detailUrl` | `detail.detail_url` | 卡片链接的正规来源 |
| `TaobaoItemDetail.shop` | `detail.nick` | |
| 诊断 | `requestId` / `recordTime` / `error` / `warning` | 只进服务端日志 |

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

- 计费相关的失败码：`303` 每日配额、`601` 账户余额、`602` TOKEN 限额（后两者共享账户余额，TOKEN 限额不是资金划拨）。
- 一轮 8 件商品 = 16 次调用；卡片缓存 24h 是为了让重复妆容不重复烧配额。
- 出现 `303` / `601` / `602` / `302` 时**立即停止本轮剩余请求**，避免把配额和余额烧在一个已经失败的轮次上。

## 9. 怎么核对本文没写错

1. OpenAPI 定义（字段和参数以它为准）：
   - `https://docs.justoneapi.com/openapi/taobao-and-tmall/product-search-v2-zh.json`
   - `https://docs.justoneapi.com/openapi/taobao-and-tmall/product-details-v3-zh.json`
2. **真实响应示例（不需要 token）**——本文第 4 节的字段就是这么核对的：

```bash
curl -G --data-urlencode "api=/api/taobao/search-item-list/v2" \
  https://api.justoneapi.com/status/api-example/detail
curl -G --data-urlencode "api=/api/taobao/get-item-detail/v3" \
  https://api.justoneapi.com/status/api-example/detail
```

返回 `{code, data:{api, checkedAt, synthetic, example:{...真实响应...}}, message}`；`synthetic: false` 表示是真调用抓下来的样本。文档站页面上的「响应示例」就是用它渲染的，所以这两条命令能拿到的信息比页面正文多。

3. L1 测试用上面两个示例裁剪出的 fixture（去掉页内字段，保留 2–3 条真实条目）做映射回归；字段改名时先改本文，再改 fixture，再改实现。

2026-09-21 用真实 token 核对的结果（调用耗时、`code=301` 的触发条件、`uprightImg` 实测全空、图片直连与商品链接可达性）记在 [09-21-taobao-product-cards.md](./09-21-taobao-product-cards.md) 第 13 节。

## 10. 未确认

1. **详情 V3 对天猫商品**：示例是淘宝商品，天猫商品在 V3 下的字段差异（是否同样给 `detail_url`）待实测。
2. **搜索每页条数与卡片混排比例**：只观测到 1 页 48 条 + 3 张非商品卡片，未验证是否稳定。
3. **QPS 与并发上限**：平台文档只给建议超时，没有公开速率数字；并发 2 是保守取值，实测到 `302` 再下调。
4. **`total_sold` / `sales` 的口径**：未验证是 30 天还是累计，卡片上暂不展示。
