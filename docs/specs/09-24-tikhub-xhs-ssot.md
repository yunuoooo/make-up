# TikHub 小红书接口 SSOT

Status: 供应商文档已核对；**图文详情与搜索的形状都用真实响应核对过**（2026-09-24 实调；两份 fixture 即样例，token 与签名已换假值）。**视频详情**的形状来自 2026-09-25 的一次真实调用，见第 2.3 节
Date: 2026-09-24（2026-09-26 修订：检索放开视频、补视频详情端点与字幕口径）
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
| 本项目用到的端点 | `GET /api/v1/xiaohongshu/app_v2/search_notes`、`GET /api/v1/xiaohongshu/app_v2/get_image_note_detail`（图文）、`GET /api/v1/xiaohongshu/app_v2/get_video_note_detail`（视频） |

**检索不再按类型过滤**（2026-09-26 决策，推翻原「决策 11」）：`note_type` 传 `不限`，图文和视频一起返回；详情阶段按 `type` 分流到对应的详情端点。原决策 11 的理由（「视频只有封面、拿不到画面」）已被字幕路径推翻，见 [09-25-video-understanding.md](./09-25-video-understanding.md)。

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

**笔记类型**（2026-09-26 改）：传 `note_type=不限`，图文与视频**都要**。曾经固定传 `普通笔记`（原决策 11，Just One 的对应取值是 `NORMAL_NOTE`），理由是「视频笔记只有封面、拿不到画面」——字幕路径（第 2.3 节）让这个理由不成立了，于是放开。

`不限` 是参数的**默认值**，所以实现上应当**不传这个参数**而不是显式传中文字面量：少一个会被抄错的中文枚举。留一个 `note_type=普通笔记` 的保险丝不如留一个 `note_type=视频笔记` 的调试开关有用（想单独验证视频端点时用得上）。

类型分流发生在**详情**阶段，不在检索阶段：搜索条目里带 `type`（第 7.1 节），映射层把它带出来，详情按它选端点。详见第 2.3 节。

### 2.2 详情：`GET /api/v1/xiaohongshu/app_v2/get_image_note_detail`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `note_id` | 二选一 | 笔记 ID，如 `697c0eee000000000a03c308` |
| `share_text` | 二选一 | 分享链接，支持 `xiaohongshu.com` 长链与 `xhslink.com` / `xhslink.cn` 短链 |

**两个都给时以 `note_id` 为准**；我们只用 `note_id`（链路是「先搜索拿 id 再读详情」，不需要分享链接）。

⚠️ **供应商明示的计费陷阱**：传入错误或不存在的笔记 ID（或分享链接解析失败）时，接口**仍正常响应**，但 `data` 里是上游的「服务异常」信息，**这一次同样计费**。这给 noteId 闸门（集成本文第 3.4 节）加了第二个理由：拦住不合法的 id 不只是省时间，是**省钱**。

⚠️ **本端点只对图文笔记用。** 对视频笔记它只返回封面、没有播放地址与字幕——视频走第 2.3 节。分流靠搜索条目里的 `type`，不要靠「先试图文端点失败了再试视频端点」：**每次尝试都计费**。

### 2.3 视频详情：`GET /api/v1/xiaohongshu/app_v2/get_video_note_detail`

参数与计费陷阱与 2.2 节**完全一致**（`note_id` / `share_text` 二选一、`note_id` 优先、无效 id 照样计费）。差异只有响应形状。

**形状比图文端点少一层**——这是本端点最容易踩的一处：

| 端点 | 笔记本体路径 | 差别 |
| --- | --- | --- |
| 图文 `get_image_note_detail` | `data.data[0].note_list[0]` | 多一层 `note_list` |
| 视频 `get_video_note_detail` | `data.data[0]` | **数组元素直接就是笔记** |

⚠️ **2026-09-26 复核改正**：视频这一格曾写作 `data.data.data[0]`（多一层 `.data`）。实调的真实响应是 `body.data.data[0]`——数组元素就是笔记，**没有**再多一层。同一个数组里 `[1]`、`[2]` 是推荐笔记（有 `id`/`title`/`*_count`，但没有 `video_info_v2`），所以**必须取 `[0]`**。

两个端点各自一个解包函数，不要复用——但要知道**复用的后果不是报错**：把视频响应喂给只认 `note_list` 的 `pickDetailEntry`，它会走「是数组就取 `[0]`」那条分支，把笔记**碰巧**映射出来（2026-09-26 实测确认）。也就是说**用错解包函数不会当场炸**，只会在上游把推荐笔记排到前面、或图文端点换了包装时静默给错笔记——这比抛 `SHAPE_DRIFT` 更危险，所以分流要靠**调用前**就知道的类型，不要靠「形状看起来能读」。

**实测字段表**（2026-09-25 真实调用，样本是一条 418 秒的妆容教程）：

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 播放地址 | `video_info_v2.media.stream.<codec>[].master_url` | codec 键为 `av1` / `h264` / `h265` / `h266` |
| stream 项字段 | 同上数组的每一项 | `stream_type` / `master_url` / `backup_urls[]` / `width` / `height` / `weight` / `default_stream` / `duration` / `video_codec` / `audio_bitrate` |
| **空 codec 是空数组** | 同上 | 样本里 `av1`、`h266` 都是 0 项。**不过滤空数组会挑到 `undefined`** |
| **字幕** | `video_info_v2.media.video.subtitles.{source,zh-CN,en-US}[].url` | 是 **`.srt`**，带时间戳。这就是视频理解链路的信息来源 |
| 字幕数组项的字段 | 同上数组的每一项 | `language` / `url` / `type` / `format`（2026-09-26 实测）。**语言仍以键名为准**，不要读 `language` |
| 封面 | `video_info_v2.image.first_frame` → `.thumbnail` → `.thumbnail_dim` | 样本只出现后两个；`images_list[0]` 通常也是这张封面 |
| 摘要 | `video_info_v2.media.video.md5` | 可做缓存键（**不要缓存 URL**，见第 7.6 节） |
| **人声** | `video_info_v2.media.video.opaque1.hasHumanVoice` | **是字符串不是布尔**：`"true"` / `"false"`（**必须按字符串比**，`=== true` 永远不成立）。没有人声 = 没有口播价值（纯音乐 + 字幕贴纸那种），分流时直接过掉，不必再取字幕 |
| 人声置信度 | `…opaque1.audioClsInfo` | **JSON 字符串**，`JSON.parse` 后取 `.speech_ratio`（0–1）。`hasHumanVoice` 的连续版本，做阈值判断时更有用；解析失败按 null 处理，**不要让它把整篇带崩** |
| 是否支持字幕 | `…opaque1.isSupportSubtitle` | 与「实际有没有字幕轨道」不是一回事——**以 `subtitles` 里有没有非空数组为准**，这个只作参考 |

三者都在 `opaque1` 下——这是实测里唯一一处**名字看不出内容**的容器（`opaque` 意为不透明），字段名靠这次抽样脚本钉住的：`.tmp/xhs-subtitle-coverage.mjs`。

**时长有三处、单位不一致**（样本值）：

| 位置 | 样本值 | 单位 |
| --- | --- | --- |
| `capa.duration` | 418 | **秒** |
| `media.video.duration` | 419 | **秒** |
| `stream[].duration` | 418585 | **毫秒** |

映射层统一成**秒**，并挑一个口径写死（建议 `media.video.duration`，它和播放地址同一棵树），别三处混用。

**播放直链是 `http://` 不是 `https://`**——与图片那次同样的坑，`normalizeUrl`（`lib/xhs/tikhub.ts`）已经在处理，复用即可。

⚠️ **字幕地址不走同一条规则**（2026-09-26 复核改正）：实测它**已经是 `https://`**，域名是 **`sns-subtitle-s8.rednotecdn.com`**——**不在 `xhscdn.com` 上**。白名单如果只写 `xhscdn.com`，这条链路会永远返回 `transcript-failed`（规格第 6.1 节原文如此，已在实现里改正为两个域名都收）。仍然统一过一遍 `normalizeUrl`（协议相对与 http 的历史形态都还在别处出现），但别指望靠它拿到正确域名。

**`.srt` 的格式（2026-09-25 抽样脚本实测，标准 SRT）**：

```
1
00:00:00,120 --> 00:00:02,480
大家好，今天教大家一个通勤妆

2
00:00:02,480 --> 00:00:05,900
第一步我们先上一个妆前
```

解析口径（照 `.tmp/xhs-subtitle-content.mjs` 的做法，已在真实样本上跑通）：

- 按**空行**分块；块内找**含 `-->` 的那一行**，它前面是序号、后面是正文（正文可能多行，用空格接起来）
- 起点时间取 `-->` **左侧**，格式 `HH:MM:SS,mmm`（**逗号**是毫秒分隔符，不是点）
- 认不出结构就按 `transcript-failed` 处理，**不要猜**（格式漂移在本链路里已经发生过）

⚠️ **取 `.srt` 时带了 `User-Agent: Mozilla/5.0`**（抽样脚本如此）。**是否必需未验证**——稳妥起见照带，别裸请求。（视频直链那次是裸请求验通的，两者不是一回事，别互相推定。）

**直链无防盗链、支持 Range**（2026-09-25 实测）：不带 UA、不带 Referer 的裸请求即返回 `206` + `ftypisom` 标准 MP4，`content-range: bytes 0-262143/74523008`；三个 CDN 域名（含 `backup_urls`）都通。字幕路径用不到这条，记在这里是因为它是「字幕取不到时」唯一的替代入口。

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

## 5. **图文**详情 `data.data[0].note_list[0]` 的字段（真实样例核对过）

> 视频详情的字段在**第 2.3 节**（形状不同，字段也不同，不要互抄）。本节只讲图文端点。

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
   - 这一页 20 条**全是 `normal`**：当时固定传 `note_type=普通笔记`，服务端过滤确实生效（客户端因此还加了一道视频兜底过滤）。**两道过滤 2026-09-26 都已删除**：现在不传 `note_type`，同一页会同时出现 `normal` 与 `video`（实测 `{"video":15,"normal":5}` 这种分布）。
   - **搜索条目里也带 `xsec_token`**：映射层只取白名单字段，测试钉住「不许漏出去」。
2. **分页凭据的位置（已采样）**：`search_id` 与 `search_session_id` 在内层顶层；同层还有 `page` / `next_page`，`hasMore` 因此直接看 `next_page`。
3. **单价、套餐、并发与每日额度**：供应商未公布，要登录控制台看；`429` 的触发阈值未知。集成本文第 4 节的成本口径因此只有调用次数，没有金额。
4. **「服务异常」内层码的具体取值**：样例只给了成功态（`code=0` + `成功`）。失败态按「内层 code !== 0 或 success !== true」判定，具体码值待补。
5. **图文笔记是否也会命中「只有封面」的分支**：文档说这是视频笔记的限制，未在图文笔记上验证过。
6. ~~视频端点路径的完整写法~~ → **已确认**：`/api/v1/xiaohongshu/app_v2/get_video_note_detail`（抽样脚本第 53 行的真实调用）。
7. **没有任何字幕的视频长什么样**：`subtitles` 是整体缺失，还是语言键都在但数组为空？抽样脚本对两者都做了防御（`Array.isArray(subs[k]) && subs[k].length > 0`），所以**它没证明**实际是哪种。这决定降级分支怎么写，值得优先补一次。
   - 实现上**两种都当 `no-transcript` 处理**（按「键缺失 / 数组为空」都算没有轨道），所以这条不影响正确性，只影响文案精度。
   - ~~字幕数组项除 `url` 外还有什么字段~~ → **2026-09-26 已核**：`language` / `url` / `type` / `format`。语言仍取 `subtitles` 的**键名**。
8. **`.srt` 的体量**：样本 6053 字符。长视频（十几分钟）会到多大、`XHS_API_TRANSCRIPT_LIMIT` 的 20000 够不够，未测。格式与解析口径本身已实测确认（第 2.3 节）。

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

### 视频详情的映射（走 2.3 节的端点）

字段名与图文**重合但不保证一致**，所以映射层各自成函数。已实测确认的：

| 内部字段 | 上游来源 | 规则 |
| --- | --- | --- |
| `noteId` | `.id` | **缺则用请求参数兜底**（同图文，线上事故的教训） |
| `title` | `.title` | 压缩空白 |
| `noteType` | `.type` | 这里是 `video` |
| `durationSeconds` | `media.video.duration` | **统一成秒**；三处时长口径见第 2.3 节（样本里 `capa.duration` 与它差 1 秒，别混用） |
| `cover` | `video_info_v2.image.first_frame` → `.thumbnail` → `.thumbnail_dim` | 沿用 `normalizeUrl`（http→https）；`images_list[0]` 为空时才用 |
| `text` / `tags` / `user` / `stats` | `.desc` / `.hash_tag[].name` / `.user.nickname` / 四个 `*_count` | **2026-09-26 实测确认与图文端点同名同形**（原「未确认」项已核） |
| ~~`playUrl`~~ | `video_info_v2.media.stream.<codec>[].master_url` | **刻意不映射**：没有消费者，且是带签名的 URL——不进工具输出、日志、SSE、trace（视频理解规格第 4.1 节）。要取时**必须过滤空的 codec 数组**（样本里 `av1`、`h266` 都是 0 项），否则挑到 `undefined` |
| `subtitles` | `video_info_v2.media.video.subtitles.{source,zh-CN,en-US}[].url` | 语言来自**键名**。取第一个非空数组，顺序 **`source` → `zh-CN` → 其余**（`source` 是原始语言轨；实测脚本用的就是这个顺序） |
| `md5` | `.md5` | 缓存键 |

~~**未确认**：视频详情里 `desc`（正文）、`hash_tag`、`user`、`images_list`、`*_count` 是否与图文端点同名同形。~~ → **2026-09-26 已核**：同名同形（见上表）。注意视频的 `desc` 通常很短（就是标题加一串话题），真正的讲解在字幕里。

对外形状沿用集成本文第 3.2/3.3 节的受控 JSON——**技能与工具层不因换供应商改动**。

## 9. 凭据与配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `XHS_API_BASE_URL` | `https://api.tikhub.io` | 换供应商或指向沙箱时才改 |
| `XHS_API_TOKEN` | 空 | TikHub 的 API Token（在 TikHub 用户中心创建）。为空即视为未配置：**不发任何请求**，链路整体降级 |
| `XHS_API_TIMEOUT_SECONDS` | `60` | 单请求超时（实测详情往返 20s 量级，仍待 P95） |
| `XHS_API_BUDGET_SECONDS` | `60` | 本轮累计上游耗时预算 |
| `XHS_API_SEARCH_PAGES` | `2` | 搜索翻页上限 |
| `XHS_API_DETAIL_LIMIT` | `10` | 详情篇数上限（技能要求的 6–10 篇的上界；每篇一次计费调用） |

- token 在**请求头**：不要把它写进日志、错误信息、SSE、trace 或异常堆栈。
- `lib/pi/events.ts` 的 `redactSensitive` 仍覆盖 `XHS_API_TOKEN` 的值（按变量名匹配 `TOKEN` + 按值替换）——**换到 header 不等于可以不脱敏**，它还是可能被模型或工具结果带出来。

## 10. 与 Just One 的差异（迁移时的对照表）

| | Just One | **TikHub（现在）** |
| --- | --- | --- |
| 鉴权 | query `token=` | **header `Authorization: Bearer`** |
| 成功判据 | 外层 `code === 0` | 外层 `code === 200` **且** 内层 `data.code === 0` / `success === true` |
| 业务码 | 100/301/302/303/601/602… | 外层用 HTTP 语义（401/403/429/422/5xx）；内层只判「服务异常」 |
| 笔记类型 | `noteType=NORMAL_NOTE`（只取图文） | `note_type` **不传**（即 `不限`，图文视频都要，中文枚举） |
| 分页 | 无状态（`page`） | **有状态**：第 2 页起要带首屏的 `search_id` + `search_session_id` |
| 无效 id | 返回空 `data` | 返回「服务异常」，**且照样计费** |
| 详情形状 | `data[0]` 平铺（V6） | `data.data[0].note_list[0]`（V3 式嵌套） |
| 免费排障入口 | `/status/api-example/detail`（官方样例） | 每次响应的 `cache_url`（24h） |
