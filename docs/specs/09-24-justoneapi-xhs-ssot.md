# Just One API 小红书接口 SSOT

Status: **已作废（2026-09-24）**——xhs 链路已换成 TikHub（[09-24-tikhub-xhs-ssot.md](./09-24-tikhub-xhs-ssot.md)）。作废原因：Just One 的详情对图文笔记也返回 `code=0` + 空 `data`（实测 7/7），TikHub 对同一篇能拿到全文。本文保留为换供应商的依据与字段对照；**淘宝链路仍在使用 Just One**，那份 SSOT 是 [09-21-justoneapi-taobao-ssot.md](./09-21-justoneapi-taobao-ssot.md)。

Status: 已按供应商文档 + **真实响应样例**（`synthetic: false`，未消耗 token）核对；延迟、配额与链接可达性见第 15 节待实测
Date: 2026-09-24
Related specs: [09-07-xhs-mcp-integration.md](./09-07-xhs-mcp-integration.md)（本次要替换的取数链路） · [09-21-justoneapi-taobao-ssot.md](./09-21-justoneapi-taobao-ssot.md)（同平台、本文体例参照） · [09-21-taobao-product-cards.md](./09-21-taobao-product-cards.md)

## 0. 文档目的

本文是「把小红书取数从 `xiaohongshu-mcp` 换成 Just One API」的唯一事实来源：端点、鉴权、参数、响应字段、错误码、超时、映射与配额只在这里定义一次，代码里只允许有**一处**实现。其它文档和注释引用本文，不复述字段名。

供应商是 **Just One API**（`https://api.justoneapi.com`），与本项目已在用的淘宝接口**同一个平台、同一套 `token` 查询参数**——换供应商只改一处的原则同样适用：实现集中在 `lib/xhs/justoneapi.ts`（迁移时新建，见第 13 节）。

**本文只解决「怎么调这个 API」**，不解决「Agent 行为怎么变」——技能（`xiaohongshu-makeup-advisor-latest/`）和系统提示词的行为约束不因换数据源而改写。

## 1. 接入点与鉴权

| 项 | 值 |
| --- | --- |
| 文档站 | `https://docs.justoneapi.com` |
| Base URL | `https://api.justoneapi.com`（OpenAPI `servers` 的「全球生产 API（默认）」） |
| 鉴权 | **查询参数 `token`**，无签名、无 key/secret、无 header |
| 传输 | 全部 GET，无请求体 |
| 本项目用到的端点 | 笔记搜索 V4、笔记详情 V6、笔记评论 V4，可选二级评论 V2 |

与淘宝链路共用平台但**不共用端点**；`token` 是否可复用同一个值取决于账号权限，见第 15 节第 1 条。

## 2. 端点

| 用途 | 端点 | 版本 | OpenAPI 定义（字段以它为准） |
| --- | --- | --- | --- |
| 找笔记 | `GET {BASE}/api/xiaohongshu/search-note/v4` | V4 | `note-search-v4-zh.json` |
| 读正文、话题、图、分享链接 | `GET {BASE}/api/xiaohongshu/get-note-detail/v6` | V6 | `note-details-v6-zh.json` |
| 读一级评论 | `GET {BASE}/api/xiaohongshu/get-note-comment/v4` | V4 | `note-comments-v4-zh.json` |
| 读二级评论（可选） | `GET {BASE}/api/xiaohongshu/get-note-sub-comment/v2` | V2 | `comment-replies-v2-zh.json` |
| 解析用户给的短链（可选，入站方向） | `GET {BASE}/api/xiaohongshu/share-url-transfer/v1` | V1 | `share-link-resolution-v1-zh.json` |

定义文件在 `https://docs.justoneapi.com/openapi/xiaohongshu-rednote/` 下；**文件名与端点版本号不对应**（评论回复 V2 的定义叫 `comment-replies-v2-zh.json`），照上表抄，不要按规律推导。

### 2.1 笔记搜索 V4

```text
GET {BASE}/api/xiaohongshu/search-note/v4?token={TOKEN}&keyword={关键词}&page={页码}
```

| 参数 | 位置 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `token` | query | 是 | — | 访问令牌 |
| `keyword` | query | 是 | — | 搜索关键词 |
| `page` | query | 否 | `1` | 页码，从 1 开始 |
| `sortType` | query | 否 | `general` | `general` 综合／`popularity_descending` 热度／`time_descending` 时间／`comment_descending` 评论数／`collect_descending` 收藏数 |
| `noteType` | query | 否 | `ALL` | `ALL`／`VIDEO_NOTE` 视频／`NORMAL_NOTE` 图文 |
| `timeFilter` | query | 否 | `ALL` | `ALL`／`ONE_DAY`／`ONE_WEEK`／`HALF_YEAR` |

文档注明这是**移动应用版本**的搜索流程，「搜索结果更准确」。

**`noteType=NORMAL_NOTE` 是一条可以直接用的过滤条件**：MCP 链路里「视频笔记的详情必然超时」（[09-07 第 12 节](./09-07-xhs-mcp-integration.md)）花了大量力气在工具层拦截，这里换成服务端过滤。取舍见第 13 节。**现已采用**：v1 的检索固定传 `NORMAL_NOTE`（见 [集成本文](./09-24-xhs-api-integration.md) 决策 11）——理由不再是「视频详情会超时」，而是视频笔记在本链路里只有封面、给不出完成妆画面。

### 2.2 笔记详情 V6

```text
GET {BASE}/api/xiaohongshu/get-note-detail/v6?token={TOKEN}&noteId={笔记ID}
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `token` | query | 是 | 访问令牌 |
| `noteId` | query | 是 | 笔记 ID，取自搜索结果的 `notes[].id` |

一次只接一个 `noteId`：批量靠调用方循环，上游没有批量参数。**不需要 `xsec_token`**——这是与 MCP 链路最大的入参差异（MCP 的 `get_feed_detail` 必须带搜索返回的 `xsec_token`）。

### 2.3 笔记评论 V4

```text
GET {BASE}/api/xiaohongshu/get-note-comment/v4?token={TOKEN}&noteId={笔记ID}&sort=like_count
```

| 参数 | 位置 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `token` | query | 是 | — | 访问令牌 |
| `noteId` | query | 是 | — | 笔记 ID**或含 `/explore/` 的 URL**（本端点比详情端点宽松） |
| `lastCursor` | query | 否 | — | 上一页响应里的 `cursor` 原样回传 |
| `sort` | query | 否 | `latest` | `normal`／`latest`／`like_count` |

### 2.4 二级评论 V2（可选）

`noteId`（必填）＋ `commentId`（必填，一级评论的 `id`）＋ `lastCursor`（可选）。

只在需要看「评论区在反驳什么」时才调：一级评论接口的 `sub_comments` 在样例里是**空数组**，而 `sub_comment_count` 可以是 37——回复不在线，必须单独取。

### 2.5 分享链接解析 V1（可选，入站方向）

`shareUrl`（必填，`http(s)://xhslink.com/` 短链）→ 返回 `data.redirect_url`，即带 `xsec_token` 的完整分享链接，可从中解析 `noteId`。

用途是**用户丢过来一条短链时反查笔记**，不是用来生成我们自己的链接。它反过来说明第 8 节的一个事实：小红书自己分享笔记时，链接里**一律带 `xsec_token`**。

## 3. 为什么是 V4 / V6 / V4

平台同一能力有多代版本（`note-search-v1..v4`、`note-details-v1..v7-deprecated`、`note-comments-v2/v3/v4`），实测差异如下。

### 3.1 搜索：V4 优于 V3

| | V3 | V4（选用） |
| --- | --- | --- |
| 结果字段 | `data.items[]`，与页面状态混在一起 | `data.notes[]`，干净的笔记对象 |
| 排序/时间参数名 | `sort` / `noteTime` | `sortType` / `timeFilter` |
| 文档定位 | 网页搜索流程 | **移动应用**搜索流程，「搜索结果更准确」 |

### 3.2 详情：V6 优于 V3

| | V3 | V6（选用） |
| --- | --- | --- |
| `data` 结构 | `data[0]` 是包装层 `{comment_list, model_type, note_list[], track_id, user}`，正文在 `note_list[0]` | `data[0]` **就是笔记本体**（样例平铺 66 字段） |
| 正文 | `note_list[0].desc` | `data[0].desc` |
| 图片 | `url` 为 `http://`，另有 `url_multi_level{high,low}` | `url` 为 `https://`，`url_size_large` **为空** |
| 评论 | 有 `comment_list`（样例为空，等于没有） | 无，评论全靠评论接口 |
| 视频笔记 | 无 | 多一个 `video_info_v2`（封面/媒体） |

选 V6：少一层 `note_list` 间接、图片直接给 https、且 `v7` 已被文档标为 deprecated，V6 是当前最新有效版本。

### 3.3 评论：V4 优于 V2/V3

V2/V3/V4 的参数与 `data` 形状完全一致，V4 只多一个 `sub_comment_cursor`——可以直接从一级评论翻它的二级评论，省掉一次「先取二级评论首页」的调用。用 V4。

## 4. 响应信封与业务码

四个端点信封一致，与淘宝接口**逐字段相同**：

```json
{ "code": 0, "message": null, "data": { }, "recordTime": null, "requestId": "..." }
```

- **先判 `code`，再看 `data`**：HTTP 200 也可能是业务失败；HTTP 4xx/5xx 的响应体同样是这个信封。
- `code === 0` 才是成功；`message`／`recordTime`／`requestId` 实测可能缺失，不能按必填处理。
- `requestId` 是供应商侧排障 ID：进服务端日志，不进客户端 payload。

| code | 含义 | 我方处理 |
| --- | --- | --- |
| 0 | 成功 | 正常映射 |
| 100 | Token 无效或已失效 | 整批停止，不重试；记日志提示检查 `XHS_API_TOKEN` |
| 101 / 202 / 300 / 404 / 503 | 枚举里有、文档未给含义 | 当未知失败，不重试 |
| 301 | 采集失败，请重试 | 重试一次，仍失败则放弃该次调用 |
| 302 | 超出速率限制 | 不重试，本轮剩余请求降并发或放弃 |
| 303 | 超出每日配额 | 整批停止 |
| 400 | 参数错误 | 放弃该次调用（多半是关键词或 noteId 非法） |
| 500 | 内部服务器错误 | 重试一次，仍失败则放弃 |
| 600 | 权限不足 | 整批停止（端点未开通时也是这个码，见第 15 节） |
| 601 | 账户余额不足 | 整批停止 |
| 602 | TOKEN 限额超限 | 整批停止 |

HTTP 层另有 `400 / 401 / 403 / 429 / 500 / 503`，与业务码并存，**判据只有 `code`**。第 2 节那张表里的「HTTP 状态」与「业务码」不是一一对应关系。

## 5. `data` 的形状

以下字段名与统计数字全部来自 2026-09-23／24 抓取的真实样例（关键词与笔记无关妆容，仅用于核对结构）。

### 5.1 搜索 V4：`data.notes[]`

一页 **20 条**；`has_more: true`；`total: 20`（**等于本页条数，不是全站命中数**，不要当总数展示）。另有 `statistics{total_items, note_count, video_count, ads_count, recommend_count}`（样例 20/15/5/0/0）、`ads[]`（样例为空）、`recommend_queries`、`search_meta`、`api_info`。

单条笔记字段：

| 上游字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 笔记 ID，详情/评论接口的入参 |
| `title` | string | 标题，纯文本 |
| `desc` | string | **正文预览，实测被截断到约 60 字符**，见第 6 节 |
| `type` | string | `normal` 图文／`video` 视频 |
| `user.nickname` | string | 作者展示名 |
| `user.userid` / `user.red_id` | string | 作者 ID／小红书号 |
| `user.images` | string | 头像，https 绝对地址 |
| `liked_count` / `comments_count` / `collected_count` / `shared_count` | number | 互动数 |
| `images_list[]` | array | 图组，取值与格式见第 7 节 |
| `timestamp` | number | 发布时间（Unix 秒） |
| `last_update_time` | number | 样例为 0 |
| `tags` | array | **样例 20 条全为空数组**，话题名要从详情接口的 `hash_tag[]` 取 |
| `geo_info.distance` | string | 样列为空 |

- `liked` / `collected` / `niced` / `followed` / `user.red_official_verified` / `has_music` 是**账号态字段**：我们无登录态，一律为 `false`，不映射。
- **搜索结果里没有 `xsec_token`，也没有评论内容**（只有 `comments_count`）。

### 5.2 详情 V6：`data[0]`

`data` 是数组，`data[0]` 就是笔记本体（样例 66 个字段）。我们用到的：

| 上游字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 笔记 ID。**样例里有，但文档没保证**（OpenAPI 把 `data` 标成无类型 `{}`）：2026-09-24 线上出现过响应缺 `id` 的情况，映射层因此必须用**请求参数兜底**，并且再认 `note_id` / `noteId` 两个键名——缺 id 就把整篇丢掉是错的，见集成本文第 3.3 节 |
| `title` | string | 标题 |
| `desc` | string | **正文全文**，话题以内联文本形式出现（`#话题名[话题]#`） |
| `type` | string | `normal`／`video` |
| `hash_tag[]` | array | 话题，元素取 `.name`；样例 4 个 |
| `topics[]` | array | 话题详情（含 `id`/`name`/`link`），与 `hash_tag` 部分重叠 |
| `images_list[]` | array | 图组，格式与搜索不同，见第 7 节 |
| `user.nickname` / `user.name` | string | 作者展示名（两者样例一致） |
| `user.userid` / `user.red_id` / `user.images` | string | 作者 ID／小红书号／头像 |
| `time` | number | 发布时间（Unix 秒）。**搜索叫 `timestamp`，详情叫 `time`** |
| `ip_location` | string | IP 归属地 |
| `view_count` | number | 样例为 0（小红书已不在移动端返回真实阅读数） |
| `liked_count` / `comments_count` / `collected_count` / `shared_count` | number | 互动数 |
| `share_info.link` | string | **带 `xsec_token` 的分享链接**，见第 8 节 |
| `share_info.title` / `share_info.content` / `share_info.image` | string | 分享卡片标题/正文/图 |
| `video_info_v2.image` | object | 视频笔记封面（图文笔记无此项） |

- 其余（`api_upgrade`、`biz_map`、`widgets_context`、`widgets_groups`、`function_switch`、`*_config`、`foot_tags`、`ats`、`cooperate_binds`、`countdown`、`downgrade_type`、`share_code_flag`、`media_save_config`…）是**页内状态与功能开关**：不映射、不落盘、不转发、不进日志。
- `share_info.link` 之外的 `share_info` 字段是分享卡片素材，除标题外本次不用。

### 5.3 评论 V4：`data.comments[]`

`data` 为对象：`comment_count`（样例 933）、`comment_count_l1`（792）、`comments[]`（**一页 10 条**）、`cursor`、`has_more`、`current_sort_strategy`、`all_sort_strategies`、`page_context`、`user_id`。

| 上游字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 评论 ID，二级评论接口的 `commentId` |
| `content` | string | 评论正文 |
| `like_count` | number | 点赞数，可用于挑「高赞共识」 |
| `user.nickname` | string | 评论者展示名 |
| `user.images` | string | 评论者头像 |
| `sub_comment_count` | number | 回复数（**回复内容不在线**） |
| `sub_comment_cursor` | string | 直接翻该条评论的回复（V4 新增） |
| `time` | number | 评论时间（Unix 秒） |
| `show_type` | string | 样例 `common` |
| `hidden` / `status` | bool/number | 审核态，映射时过滤掉 `hidden: true` |

- 文档给的 `sort` 枚举是 `normal`/`latest`/`like_count`（默认 `latest`），但**样例返回的 `current_sort_strategy` 是 `"default"`**，是枚举外的取值；`all_sort_strategies` 样例为空数组。**不要依赖这个字段做判断**（文档 drift，同淘宝 SSOT 第 3 节的处理方式）。
- `page_context`、`biz_label`、`show_tags`、`translation_strategy`、`score`、`at_users` 等不映射。

### 5.4 二级评论 V2

`data{comments[], cursor, has_more, page_context}`；单条结构与 5.3 相同，另多一个 `target_comment`（被回复的那条，只有 `id` 和 `user.nickname` 可用）。

## 6. 正文只有详情接口给全

**这是本次换源最容易踩空的一条**：搜索接口的 `desc` 是**截断预览**。

| | 搜索 V4 `notes[].desc` | 详情 V6 `data[0].desc` |
| --- | --- | --- |
| 实测长度 | 20 条：24–60 字符，19 条落在 58–60 | 详情样例 71（V6）／159（V3）字符，为正文全文 |
| 结尾 | 断在半句 | 完整，含全部 `#话题[话题]#` |

结论：**只靠搜索接口无法完成技能要求的「从正文提取妆容特征与产品信息」**（技能明确要求「不要用搜索摘要补全文案」）。搜索负责**定位**（标题、作者、类型、互动数、封面），详情负责**内容**。因此每篇要读正文的笔记至少 1 次详情调用，这条成本不能省。

## 7. 图片：取值链与格式规范化

三个端点的 `images_list[]` 形状**各不相同**，实测：

| 端点 | `url` | `url_size_large` | 其他候选 | 格式 | 协议 |
| --- | --- | --- | --- | --- | --- |
| 搜索 V4 | 110 条里只有 **20 条非空** | **110/110 非空** | — | **heif** 110/110 | https |
| 详情 V6 | 有条目时非空 | **空** | `original`（w/5000） | webp | https |
| 详情 V3 | 非空 | 空 | `url_multi_level{high,low}` | webp | **http** |

**取值链（按顺序取第一个非空）**：`url_size_large` → `url` → `url_multi_level.high` → `original`。

**两条必须做的规范化**（均已实测验证）：

1. **`format/heif` → `format/jpg`**：搜索接口给的全是 `format/heif`，**浏览器不能渲染 HEIF**。替换 URL 里的 `format/heif` 为 `format/jpg` 后实测返回 `content-type: image/jpeg`（同一张图 84 KB，heif 原样是 130 KB）。替换不影响签名校验。
2. **`http://` → `https://`**：详情 V3 的图片（以及 `topics[].image`）是 `http://`，混内容会被浏览器拦。升到 https 后实测同样返回 200。

图片 URL 形态（搜索样例，已截断）：

```text
https://sns-na-i4.xhscdn.com/{fileid}?imageView2/2/w/608/format/heif/q/56|imageMogr2/strip&redImage/frame/0&ap=5&sc=SRH_PRV&sign=...&t=6ab3e9b4
```

- 实测出现过的图片主机：`sns-na-i4.xhscdn.com`、`sns-img-qc.xhscdn.com`、`sns-i27-ae.rednotecdn.com`（头像：`sns-avatar-qc*.xhscdn.com`、`rednotecdn.com`）。**在 `<img>` 里直连需要主机白名单**，走 `next/image` 还要配 `remotePatterns`。
- `sign` 与 `t` 是签名参数：`t` 解出来**等于样例抓取时刻**（`0x6ab3e9b4` = 2026-09-23T23:01:08+08:00，与样例 `checkedAt` 23:01:05 吻合），所以 `t` 是**签发时间，不是过期时间**。样例 URL 在约 2 小时后仍返回 200，去掉 `sign`/`t` 也返回 200——但**「去掉签名也能取」不能当成结论**，有效期未确认，落盘缓存图片 URL 有风险（见第 15 节第 3 条）。
- 每张图的 `height`/`width` 都在，可以在前端预留版位。

## 8. 笔记链接与 `xsec_token`

**问题**：把 `https://www.xiaohongshu.com/explore/{id}` 拼出来给用户，**打不开**。

| 链接形态 | 实测结果（匿名 curl，2026-09-24） |
| --- | --- |
| `https://www.xiaohongshu.com/explore/{id}` | 302 到 `/404?error_code=300031`，文案「当前笔记暂时无法浏览」；4/4 全部如此（含 3 篇当天搜索到的新笔记） |
| 详情接口的 `share_info.link`（带 `xsec_token`、`xsec_source=app_share`） | 302 到**登录页**（不是 404）——笔记本身可解析，匿名访问只被登录墙拦住 |

也就是说：**能点开的链接一定带 `xsec_token`**，这是小红书分享机制本身的形态（第 2.5 节的短链解析接口也印证：小红书自己分享时一律带 token）。

这与现行不变式冲突：[09-07](./09-07-xhs-mcp-integration.md) 第 7.3 节要求「`xsec_token` 不得进入结果、`source_url` 不得携带 `xsec_token`」，且 `lib/pi/events.ts` 的 `redactSensitive()` 会把 `xsec_token=...` 改写成 `[redacted]`——**带 token 的链接进模型上下文或 SSE 时会被就地破坏**。

两个 token 不是一回事，这是本轮需要显式拍板的地方：

- **MCP 时代的 `xsec_token`**：服务端调用 `get_feed_detail` 的**凭据**，泄露等于泄露调用能力 → 必须脱敏。
- **API 时代的 `share_info.link`**：小红书给「分享这条笔记」场景生成的**分享链接**，任何用户在 App 里点分享都会拿到一个 → 性质接近公开链接，但脱敏层仍会拦它。

两个方案：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **A（建议，第一版）** | 不输出可点链接，只给「标题 + 作者 + 小红书站内复搜关键词」。技能已经允许这样做（「链接无法稳定访问时，仍保留准确标题与创作者，方便用户在小红书内复搜」） | 用户点不回原笔记，需要自己搜 |
| B | 输出 `share_info.link`，并在脱敏层给**这一种形态**开例外（只放行 `share_info.link` 一种来源，其它位置照旧拦） | 破了一处不变式；链接会进 SSE、Langfuse trace 和答案，之后收紧成本高 |

选 A 的话，第 10 节的映射表里 `shareUrl` 一栏整体为空，`share_info.link` 只作为**服务端排障**（不落盘、不进 trace）；选 B 则要同步改 `lib/pi/events.ts`，并在本文登记为例外。

## 9. 超时、分页、重试与并发

| 项 | 值 | 依据 |
| --- | --- | --- |
| 官方建议超时 | 120s（至少 60s） | 文档明确写了「建议 120 秒；偏短会出现少量请求收不到结果」 |
| 我方单请求超时 | 60s（`XHS_API_TIMEOUT_SECONDS`） | 先取文档下限；**HTTP 调用的真实延迟待实测**（第 15 节第 2 条），实测后按 P95 收紧 |
| 我方整批预算 | 60s（`XHS_API_BUDGET_SECONDS`） | 到期即停止后续请求，已拿到的笔记照发 |
| 分页 | 搜索 `page` 从 1 开始（一篇 20 条）；评论 `lastCursor` ← 响应 `cursor` | — |
| 重试 | `code=301`、HTTP 5xx、网络超时各重试 1 次；**外加 `code=0` 但 `data` 为空** | `302/303/601/602` 重试只会继续烧配额和余额。空 `data` 值得重试是因为**失败不计费**（第 8.1 节），而它实测是「采集没成功」的伪装形态（2026-09-24：图文笔记 7/7 返回 `code=0` + 空 `data`，耗时约 20s） |
| 并发 | 2 | 平台未公布 QPS；限流码 302 出现即降并发 |

与淘宝链路同一条设计取向：**宁可少讲一篇笔记，也不让答案等着小红书**。

## 10. 映射到内部类型

这是唯一的映射表；实现之外的代码只知道右侧字段。

| 内部字段 | 上游来源 | 规则 |
| --- | --- | --- |
| `id` | `search.notes[].id` → `detail.data[0].id` | 搜索缺 `id` 即跳过该条 |
| `title` | `.title` | 压缩空白 |
| `authorName` | `.user.nickname` → `.user.name` | |
| `authorId` | `.user.userid` | 仅服务端去重使用，可不下发 |
| `text` | `detail.desc` | **只信详情**（第 6 节）；搜索的 `desc` 只用于候选排序 |
| `tags` | `detail.hash_tag[].name` | 搜索的 `tags[]` 恒为空，不要用 |
| `images[]` | `images_list[]` | 走第 7 节取值链 + heif→jpg + http→https |
| `createdAt` | `search.timestamp` / `detail.time` | Unix 秒 → 展示用日期；技能要求「可见日期」 |
| `stats` | `.liked_count` / `.comments_count` / `.collected_count` / `.shared_count` | 技能只把点赞量当传播度，不当适配性证据 |
| `comments[]` | `comment.data.comments[]` | `authorName ← user.nickname`、`text ← content`、`likeCount ← like_count`；过滤 `hidden: true` |
| `comments[].replies[]` | 二级评论接口 | 可选；不取时在结果里标明「仅一级评论」 |
| `noteType` | `.type` | `normal`/`video`，用于决定要不要取封面 |
| `sourceUrl` | `detail.share_info.link` | **默认不下发**，见第 8 节方案 A |
| 诊断 | `requestId` / `recordTime` / `message` | 只进服务端日志 |

**不映射**（搜到的字段名都在第 5 节列出）：`ads[]`、`recommend_queries`、`search_meta`、`api_info`、`statistics`、`geo_info`、`user.red_id`、`user.followed`、`liked/collected/niced`、`video_info_v2` 的原始媒体地址、`widgets_*`、`biz_map`、`page_context`、`all_sort_strategies`、`at_users`、`show_tags`。

对外形状沿用 [09-07 第 7.3 节](./09-07-xhs-mcp-integration.md)的 `raw_posts` 包（`post_id`/`title`/`author_name`/`text`/`tags`/`comments`/`source_url`），本表是它的字段来源替换版：**技能与系统提示词不需要因为换源改写**。

## 11. 凭据、配置与脱敏

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `XHS_SOURCE_MODE` | `mcp`（迁移期）→ `api` | `mock` \| `mcp` \| `api`。**该变量当前已在 `.env` 里且值为 `mcp`，但没有任何 TypeScript 代码读它**——真实生效的是 `.pi/extensions/xiaohongshu-mcp.ts`。迁移时它才第一次真正成为开关 |
| `XHS_API_BASE_URL` | `https://api.justoneapi.com` | 换供应商或指向沙箱时才改 |
| `XHS_API_TOKEN` | 空 | 为空即视为「未配置」：**不发任何请求**，链路整体降级 |
| `XHS_API_TIMEOUT_SECONDS` | `60` | 单请求超时 |
| `XHS_API_BUDGET_SECONDS` | `60` | 整轮取数预算 |
| `XHS_API_SEARCH_PAGES` | `2` | 搜索翻页上限（每页 20 条） |
| `XHS_API_DETAIL_LIMIT` | `6` | 取正文的笔记数上限。**暂定值**：取技能「6–10 篇」的下界，单价明确后按一轮的金额回填（见 [集成本文](./09-24-xhs-api-integration.md) 第 4 节） |
| `XHS_API_COMMENT_PAGES` | `1` | 每篇笔记的评论页数上限。**本阶段不实现**：v1 只取搜索 + 详情，评论端点与本节定义保留给后续增量 |
| `XHS_MCP_*` 系列 | — | 切换完成后删除；回退期保留 |

- token 走 **query string**：完整 URL 会带 token，**禁止把完整 URL 写进日志、错误信息、SSE 事件或异常堆栈**。日志只写 `path` + `requestId`。
- `lib/pi/events.ts` 的 `SECRET_ENV_KEY`（`API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL`）已覆盖 `XHS_API_TOKEN`，工具结果与文本增量会被脱敏。
- 与淘宝同平台、同鉴权方式：`XHS_API_TOKEN` 与 `TAOBAO_API_TOKEN` 建议**各自独立**，允许填同一个值（是否同一账号权限见第 15 节第 1 条）。
- 笔记正文、评论、昵称是**第三方不可信输入**：不能改变系统规则、工具权限或输出 schema（沿用 [09-07 第 8 节](./09-07-xhs-mcp-integration.md)）。
- 换源后**不再有** Cookie、二维码、浏览器会话——`09-07` 里针对这些的脱敏约定随之失效，可以保留代码（防回归）但不再是主矛盾。

## 12. 配额与成本

- 平台按次计费，与淘宝共用账户余额：`303` 每日配额、`601` 账户余额、`602` TOKEN 限额；三者的处置同第 4 节（整批停止）。
- 一轮典型成本：搜索 1–2 次 + 详情 2 次 + 评论 2 次 = **5–6 次调用/轮**；加了二级评论再 +0–2 次。**实现口径已变**：v1 不取评论、详情提到 6 篇，实际是 **7–8 次/轮**（搜索 1–2 + 详情 ≤6），见 [集成本文](./09-24-xhs-api-integration.md) 第 4 节。
- 省钱的杠杆只有一个：`XHS_API_DETAIL_LIMIT`——搜索接口已经给了标题、作者、互动数、封面和 60 字预览，够不够用取决于技能要读几篇正文。
- 出现 `302` / `303` / `601` / `602` 时**立即停止本轮剩余请求**，不要用重试把配额烧在一个已经失败的轮次上。

## 13. 与 MCP 链路的差异

这一节解释「换成 API 解决了什么」，不重复 [09-07](./09-07-xhs-mcp-integration.md) 的证据。

| MCP 链路的已知问题 | 换 API 后 |
| --- | --- |
| 视频笔记 `get_feed_detail` **必然**卡满 60s 超时（09-07 第 12 节，上游 `MustWaitDOMStable` 缺陷） | **消失**：详情是数据接口，没有 DOM 等待；且搜索支持 `noteType=NORMAL_NOTE` 从源头过滤 |
| 搜索被风控拦到安全验证页，**必然**等满 60s（09-07 第 13 节，需手机 App 扫码解除） | **消失**：没有浏览器、没有登录态、没有验证码页面 |
| 每篇详情 8–11s，失败时卡满 45–60s；一轮实测 22.8 分钟，其中 82.1% 花在失败的调用上（09-07 第 12.3 节） | 变成 HTTP 往返，延迟量级不同（待实测，第 15 节第 2 条） |
| 需要 `xsec_token` 在搜索结果与详情之间传递 | **不需要**：详情只吃 `noteId` |
| 上游会在 info 日志里输出带 `xsec_token` 的 URL，本地必须包一层启动脚本做脱敏 | **消失**：不再有本地服务与它的日志 |
| 需要维护 `.pi/extensions/xiaohongshu-mcp.ts` 的工具层拦截、二进制分发（`xiaohongshu-mcp/bin/`）、`scripts/xhs-*` 启动脚本 | 全部移除；改成一个数据源模块 + 一个只读工具扩展 |

**新引入的代价**：按次计费（MCP 是自建浏览器，边际成本为零）、外部依赖从"本机进程"变成"公网服务"、以及第 8 节的链接问题。

迁移要动的代码点（**实施情况以 [09-24-xhs-api-integration.md](./09-24-xhs-api-integration.md) 第 8 节的改动清单为准**，下表是换源前的现状）：

| 位置 | 现状 |
| --- | --- |
| `.pi/extensions/xiaohongshu-mcp.ts` | 把三个 MCP 只读工具注册成 `xhs_*`；换成 API 实现或删除 |
| `lib/pi/bridge.ts:64` | `READ_ONLY_TOOL_ALLOWLIST = "read,xhs_check_login_status,xhs_search_feeds,xhs_get_feed_detail"` |
| `lib/pi/events.ts:194-220` | `summarizeToolCall` / `summarizeToolResult` 按 `xhs_*` 名字分支 |
| `frontend/components/chat/TurnTrace.tsx:15-17` | 工具名到图标的映射 |
| `test/L1/xhs-mcp-extension.test.ts` | 钉住「视频笔记不发上游请求」的不变量；换源后该不变量由「不再有视频详情概念」取代 |

## 14. 怎么核对本文没写错

1. OpenAPI 定义（字段和参数以它为准）：

```text
https://docs.justoneapi.com/openapi/xiaohongshu-rednote/note-search-v4-zh.json
https://docs.justoneapi.com/openapi/xiaohongshu-rednote/note-details-v6-zh.json
https://docs.justoneapi.com/openapi/xiaohongshu-rednote/note-comments-v4-zh.json
https://docs.justoneapi.com/openapi/xiaohongshu-rednote/comment-replies-v2-zh.json
https://docs.justoneapi.com/openapi/xiaohongshu-rednote/share-link-resolution-v1-zh.json
```

2. **真实响应样例（不需要 token）**——本文第 5、6、7 节的字段和统计就是这么核对的：

```bash
curl -G --data-urlencode "api=/api/xiaohongshu/search-note/v4" \
  https://api.justoneapi.com/status/api-example/detail
curl -G --data-urlencode "api=/api/xiaohongshu/get-note-detail/v6" \
  https://api.justoneapi.com/status/api-example/detail
curl -G --data-urlencode "api=/api/xiaohongshu/get-note-comment/v4" \
  https://api.justoneapi.com/status/api-example/detail
curl -G --data-urlencode "api=/api/xiaohongshu/get-note-sub-comment/v2" \
  https://api.justoneapi.com/status/api-example/detail
```

返回 `{code, data:{api, checkedAt, synthetic, example:{…真实响应…}}}`；`synthetic: false` 表示是真调用抓下来的样本。本文所有样例的 `synthetic` 均为 `false`。

3. 端点清单（本文第 2 节那张表就是从这个 sitemap 里挑的）：

```bash
curl -s https://docs.justoneapi.com/zh/sitemap.xml | grep -oE '/zh/api/xiaohongshu-rednote/[a-z0-9-]+' | sort -u
```

4. L1 测试用上面样例裁剪出的 fixture（保留 2–3 条真实笔记、去掉页内字段）做映射回归；字段改名时**先改本文，再改 fixture，再改实现**。

## 15. 未确认与待决策

1. **`XHS_API_TOKEN` 能否复用淘宝那个 token**：同平台同鉴权，但权限是否包含小红书端点要真调一次才知道（否则 `code=600`）。决定权在账号，不在代码。
2. **真实延迟**：文档给 120s 是采集类接口的通用建议；本链路没有浏览器，预期是秒级，但**未实测**。第 9 节的 60s 是按文档下限取的保守值，实测 P95 后收紧。
3. **图片 URL 的有效期**：`sign`/`t` 是签名参数，`t` 已确认是签发时间；样例 URL 在 2 小时后仍可取、去掉签名也可取。**不能据此认定永久有效**——如果发现过期，缓存图片 URL 的做法（对齐淘宝卡片的 24h 缓存）就不能照搬。
4. **搜索 `desc` 的截断口径**：实测集中在 58–60 字符，是否为固定上限、长文是否给更多预览未知。结论（「正文只信详情」）不受影响。
5. **每页条数与 `total` 语义**：搜索 20 条/页、评论 10 条/页都只有单次样例；`total` 等于本页条数，疑似不是全站命中数。
6. **视频笔记在 API 链路下的表现**：预期没有 MCP 的第 12 节问题（详情是数据不是页面），但**未实测**；`video_info_v2.image` 能否稳定当封面也未验证。
7. **评论 `sort` 的有效性**：文档枚举 `normal/latest/like_count`，样例返回 `default`。按文档传 `like_count` 是否真按赞排，待实测。
8. **平台单价**：本文没有拿到小红书端点的计费数字；第 12 节只给调用次数，不给金额。
9. **已定（2026-09-24）：链接策略取方案 A**——不给可点链接，只给标题 + 创作者 + 站内复搜关键词，脱敏层不动。理由与代价见 [集成本文](./09-24-xhs-api-integration.md) 决策 4 与第 6.3 节。
10. **已定（2026-09-24）：迁移期并存**——`XHS_SOURCE_MODE` 在验收通过前保持 `mcp`，api 分支同期实现，Phase C 切默认、Phase D 删 MCP 资产；阶段与出口条件见 [集成本文](./09-24-xhs-api-integration.md) 第 10 节。
