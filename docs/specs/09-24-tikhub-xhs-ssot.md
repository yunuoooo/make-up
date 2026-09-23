# TikHub 小红书接口 SSOT

Status: 供应商文档已核对；**详情与搜索的形状都用真实响应核对过**（2026-09-24 实调；两份 fixture 即样例，token 与签名已换假值）
Date: 2026-09-24
Related specs: [09-24-xhs-api-integration.md](./09-24-xhs-api-integration.md)（架构与改动面）· [09-24-justoneapi-xhs-ssot.md](./09-24-justoneapi-xhs-ssot.md)（**本文取代它**；Just One 仍在淘宝链路使用，见 [09-21-justoneapi-taobao-ssot.md](./09-21-justoneapi-taobao-ssot.md)）

## 0. 文档目的

本文是「我们怎么调 TikHub 拿小红书数据」的唯一事实来源：端点、鉴权、参数、响应字段、错误码、计费陷阱和映射规则只在这里定义一次，代码里只允许有**一处**实现（`lib/xhs/tikhub.ts`）。其它文档和注释引用本文，不复述字段名。

换供应商的原因与代价记在集成本文第 12 节：Just One 对**图文笔记**也返回 `code=0` + 空 `data`（实测 7/7），而同一篇笔记 TikHub 能拿到全文。

## 1. 接入点与鉴权

| 项 | 值 |
| --- | --- |
| Base URL | `https://api.tikhub.io` |
| 鉴权 | **`Authorization: Bearer <token>` 请求头**——不是 query 参数 |
| 传输 | 全部 GET，无请求体 |
| 本项目用到的端点 | `GET /api/v1/xiaohongshu/app_v2/search_notes`、`GET /api/v1/xiaohongshu/app_v2/get_image_note_detail` |
| 备用（本轮不用） | `get_video_note_detail`（视频播放地址；我们检索已限定图文） |

**鉴权放 header 是相对 Just One 的一处净收益**：token 不再出现在 URL 里，少一层「完整 URL 泄漏」的风险面。日志纪律因此收窄为「不记请求头」。

供应商给的接口优先级：`App V2（本接口）> App > Web V2 > Web`。

## 2. 端点与参数

### 2.1 搜索：`GET /api/v1/xiaohongshu/app_v2/search_notes`

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `keyword` | 是 | — | 搜索关键词 |
| `page` | 否 | `1` | 页码 |
| `sort_type` | 否 | `general` | `general` / `time_descending` / `popularity_descending` / `comment_descending` / `collect_descending` / `english_preferred`（**英文枚举**） |
| `note_type` | 否 | `不限` | `不限` / `视频笔记` / `普通笔记` / `直播笔记`（**中文枚举**） |
| `time_filter` | 否 | `不限` | `不限` / `一天内` / `一周内` / `半年内`（**中文枚举**） |
| `search_id` | 否 | — | 翻页用，取自首次搜索的返回 |
| `search_session_id` | 否 | — | 同上 |
| `source` | 否 | `explore_feed` | 来源 |
| `ai_mode` | 否 | `0` | 0 关 / 1 开 |

两条要点：

1. **枚举语言不统一**：`sort_type` 是英文，`note_type` 和 `time_filter` 是中文。写死时按本文抄，不要按规律推导。
2. **翻页是有状态的**：文档明说「首次请求：只传 `keyword` 和 `page`；翻页请求：传入首次搜索返回的 `search_id` 和 `search_session_id`」。所以第 2 页起必须带上这两个值——它们就在第一页响应的**内层顶层**（第 7 节），映射层直接读；读不到才退化成只传 `page`。

**图文过滤**（决策 11）：固定传 `note_type=普通笔记`（Just One 的对应取值是 `NORMAL_NOTE`，语义相同、枚举语言不同）。实测一页 20 条全是 `normal`，服务端过滤确实生效。

### 2.2 详情：`GET /api/v1/xiaohongshu/app_v2/get_image_note_detail`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `note_id` | 二选一 | 笔记 ID，如 `697c0eee000000000a03c308` |
| `share_text` | 二选一 | 分享链接，支持 `xiaohongshu.com` 长链与 `xhslink.com` / `xhslink.cn` 短链 |

**两个都给时以 `note_id` 为准**；我们只用 `note_id`（链路是「先搜索拿 id 再读详情」，不需要分享链接）。

⚠️ **供应商明示的计费陷阱**：传入错误或不存在的笔记 ID（或分享链接解析失败）时，接口**仍正常响应**，但 `data` 里是上游的「服务异常」信息，**这一次同样计费**。这给 noteId 闸门（集成本文第 3.4 节）加了第二个理由：拦住不合法的 id 不只是省时间，是**省钱**。

视频笔记：本端点对视频笔记**只返回封面**、没有播放地址。我们检索已限定图文，正常不会遇到；万一遇到，`type` 会是 `video`，映射层按图文映射即可（有正文/封面可用）。

## 3. 响应信封

外层（两个端点一致）：

```json
{
  "code": 200,
  "request_id": "f06a775d-…",
  "message": "Request successful. This request will incur a charge.",
  "message_zh": "请求成功，本次请求将被计费。",
  "support": "Discord: …",
  "time": "2026-09-23 13:14:20",
  "time_stamp": 1790194460,
  "time_zone": "America/Los_Angeles",
  "docs": "https://api.tikhub.io/#/…",
  "cache_message": "…", "cache_message_zh": "…",
  "cache_url": "https://cache.tikhub.io/…",
  "router": "/api/v1/xiaohongshu/app_v2/get_image_note_detail",
  "params": { "note_id": "…", "share_text": "…" },
  "data": { "code": 0, "success": true, "msg": "成功", "data": [ … ], "debug_id": "…", "debug_info": "…" }
}
```

判据（**与 Just One 完全不同，不要混**）：

1. **外层 `code` 是 HTTP 语义**：`200` 才算成功（Just One 是 `0`）。
2. 外层 200 之后**再看内层**：`data.code === 0` 且 `data.success === true` 才算拿到内容；`data.msg` 是中文结果（成功是 `成功`，失败是上游的「服务异常」之类）。
3. 内层 `data.data` 才是真正的业务数据：详情是数组（`[0].note_list[0]`），搜索是 `{items: [{note: {...}}]}`（第 7 节）。
4. `cache_url`：本次响应**免费缓存 24 小时**，可直接打开看原始响应——排障时最有用的一件东西（只用于人工排障，不进代码）。
5. `debug_info` 是加密串，不解析、不落盘、不进日志。

## 4. code 与处置

| 层 | 值 | 含义 | 我方处理 |
| --- | --- | --- | --- |
| 外层 | `200` | HTTP 成功 | 继续看内层 |
| 外层 | `401` / `403` | 凭据无效或无权 | 整批停止（`auth-failed`） |
| 外层 | `429` | 限流或套餐额度用尽 | 整批停止（`quota-exhausted`），阈值未公布 |
| 外层 | `422` | 参数校验失败 | 放弃该次调用（`bad-argument`） |
| 外层 | `5xx` | 上游故障 | 重试一次 |
| 内层 | `code !== 0` 或 `success !== true` | 上游「服务异常」（**已计费**） | 当作失败**但不重试**：重试等于再付一次。连续出现按采集侧失败处理（集成本文第 3.4/3.5 节） |

**重试策略因此与 Just One 相反**：那边「失败不计费」，空 `data` 值得免费重试一次；这边**响应即计费**，只有「根本没拿到响应」的情况（5xx / 网络 / 超时）才重试一次——计费过的失败一律不重试。

## 5. 详情 `data.data[0].note_list[0]` 的字段（真实样例核对过）

**形状是 V3 式的嵌套**（`note_list[0]`、旁边还有 `comment_list` / `track_id` / `user`），不是平铺。我们用到的：

| 上游字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 笔记 ID |
| `title` | string | 标题 |
| `desc` | string | **正文全文**，带 `\n`/`\t` 与行内 `#话题[话题]#`（样例 300+ 字） |
| `type` | string | `normal` 图文 / `video` 视频 |
| `hash_tag[]` | array | 话题，元素取 `.name`（样例 6 个） |
| `user.nickname` / `user.name` | string | 作者展示名 |
| `user.userid` / `user.red_id` / `user.image` | string | 作者 ID / 小红书号 / 头像 |
| `time` | number | 发布时间（Unix 秒） |
| `ip_location` | string | IP 归属地（样例是英文 `Guangdong`） |
| `liked_count` / `comments_count` / `collected_count` / `shared_count` | number | 互动数 |
| `images_list[]` | array | 图组：`url_size_large` / `url` / `url_multi_level{high,low,medium}` / `original` / `width` / `height` |
| `view_count` | number | 移动端已不给真实阅读数（样例 0） |

**不映射**（搜到的字段名都在样例里）：`share_info`（**含带 `xsec_token` 的分享链接**）、`mini_program_info.path`、`qq_mini_program_info.path`（后两者也带 token）、`long_press_share_info`、`widgets_context` / `widgets_groups` / `function_switch` / `media_save_config` / `privacy` / `feedback_info` 等页内状态、`debug_id` / `debug_info`、`liked` / `collected` / `followed` 等账号态字段。

**图片取值链与规范化**与 Just One 版完全一致（取值链 `url_size_large` → `url` → `url_multi_level.high` → `original`；`format/heif` → `format/jpg`；`http://` → `https://`）：样例里 `images_list[0].url_size_large` 是 `format/webp`、`url` 是 `format/webp`，而 `share_info.image` 是 `http://`——**说明这条链必须留着 http→https 那一步**。

## 6. 正文只有详情给全

与 Just One 版同一个结论，不因换供应商改变：搜索的卡片只给一段**截断预览**，正文全文只有详情接口的 `desc` 给。技能里「预览不能当正文」的条款照旧成立。

## 7. 已采样的事实与仍未确认的项

1. **搜索响应形状（已采样，2026-09-24 实调）**：`data.data.items[].note{…}`，笔记字段**平铺**在 `note` 里——`id` / `title` / `desc`（截断预览）/ `type` / `user.nickname` / `images_list[]` / `timestamp` / `liked_count` 等。**包装键是 `note`，不是 `note_card`**：这一点猜错时 20 条会被全部丢掉，而结果与「真的没有结果」长得一模一样，所以映射层**先认 `note`、再认 `note_card` / 平铺**，并且在「有条目却一条都读不出来」时报出上游字段名。
   - 这一页 20 条**全是 `normal`**：`note_type=普通笔记` 的服务端过滤确实生效（客户端的视频兜底过滤因此是双保险）。
   - **搜索条目里也带 `xsec_token`**：映射层只取白名单字段，测试钉住「不许漏出去」。
2. **分页凭据的位置（已采样）**：`search_id` 与 `search_session_id` 在内层顶层；同层还有 `page` / `next_page`，`hasMore` 因此直接看 `next_page`。
3. **单价、套餐、并发与每日额度**：供应商未公布，要登录控制台看；`429` 的触发阈值未知。集成本文第 4 节的成本口径因此只有调用次数，没有金额。
4. **「服务异常」内层码的具体取值**：样例只给了成功态（`code=0` + `成功`）。失败态按「内层 code !== 0 或 success !== true」判定，具体码值待补。
5. **图文笔记是否也会命中「只有封面」的分支**：文档说这是视频笔记的限制，未在图文笔记上验证过。

## 8. 映射到内部类型

| 内部字段 | 上游来源 | 规则 |
| --- | --- | --- |
| `noteId` | 详情 `.id`；**缺则用请求参数兜底** | 再认 `note_id` / `noteId`（Just One 那次线上事故的教训：缺 id 不能丢整篇） |
| `title` | `.title` | 压缩空白 |
| `authorName` | `.user.nickname` → `.user.name` | |
| `text` | 详情 `.desc` | **只信详情**；保留换行；8000 字符后截断并置 `truncated` |
| `tags` | `.hash_tag[].name` | |
| `images[]` | `.images_list[]` | 取值链 + heif→jpg + http→https，最多 9 张 |
| `createdAt` | `.time` | Unix 秒 → `YYYY-MM-DD`（Asia/Shanghai） |
| `stats` | 四个 `*_count` | 技能只把点赞量当传播度 |
| `noteType` | `.type` | |
| 搜索条目 | `data.data.items[].note{…}`（第 7 节） | 先认 `note`，再认 `note_card` / 平铺；缺 id 的条目跳过（搜索没有可兜底的值） |
| 诊断 | 外层 `request_id` / 内层 `msg` | 只进服务端日志与工具层文案 |

对外形状沿用集成本文第 3.2/3.3 节的受控 JSON——**技能与工具层不因换供应商改动**。

## 9. 凭据与配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `XHS_API_BASE_URL` | `https://api.tikhub.io` | 换供应商或指向沙箱时才改 |
| `XHS_API_TOKEN` | 空 | TikHub 的 API Token（在 TikHub 用户中心创建）。为空即视为未配置：**不发任何请求**，链路整体降级 |
| `XHS_API_TIMEOUT_SECONDS` | `60` | 单请求超时（实测详情往返 20s 量级，仍待 P95） |
| `XHS_API_BUDGET_SECONDS` | `60` | 本轮累计上游耗时预算 |
| `XHS_API_SEARCH_PAGES` | `2` | 搜索翻页上限 |
| `XHS_API_DETAIL_LIMIT` | `6` | 详情篇数上限 |

- token 在**请求头**：不要把它写进日志、错误信息、SSE、trace 或异常堆栈。
- `lib/pi/events.ts` 的 `redactSensitive` 仍覆盖 `XHS_API_TOKEN` 的值（按变量名匹配 `TOKEN` + 按值替换）——**换到 header 不等于可以不脱敏**，它还是可能被模型或工具结果带出来。

## 10. 与 Just One 的差异（迁移时的对照表）

| | Just One | **TikHub（现在）** |
| --- | --- | --- |
| 鉴权 | query `token=` | **header `Authorization: Bearer`** |
| 成功判据 | 外层 `code === 0` | 外层 `code === 200` **且** 内层 `data.code === 0` / `success === true` |
| 业务码 | 100/301/302/303/601/602… | 外层用 HTTP 语义（401/403/429/422/5xx）；内层只判「服务异常」 |
| 图文过滤 | `noteType=NORMAL_NOTE` | `note_type=普通笔记`（中文枚举） |
| 分页 | 无状态（`page`） | **有状态**：第 2 页起要带首屏的 `search_id` + `search_session_id` |
| 无效 id | 返回空 `data` | 返回「服务异常」，**且照样计费** |
| 详情形状 | `data[0]` 平铺（V6） | `data.data[0].note_list[0]`（V3 式嵌套） |
| 免费排障入口 | `/status/api-example/detail`（官方样例） | 每次响应的 `cache_url`（24h） |
