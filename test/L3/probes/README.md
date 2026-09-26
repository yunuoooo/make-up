# 一次性探针（会真的打上游、真的计费）

这些脚本**不是测试**——不会被 `npm run test:l3` 跑到（那个 glob 只收 `*.test.ts`）。
它们是一次性调研用的：每次跑都会打真实的 TikHub 或小红书 CDN，**详情与搜索按次计费**。

2026-09-26 从 `.tmp/`（gitignore，随时会被清）搬到这里。搬家的原因写在
[视频理解规格](../../../docs/specs/09-25-video-understanding.md) 第 10.1 节：
`xhs-subtitle-coverage.mjs` 是 SSOT 第 2.3 节里 `opaque1.*` 那几个字段名的**唯一来源**，
而 `.tmp/` 一被清掉，那些字段名就没有出处了。

## 跑法

```sh
node --env-file=.env test/L3/probes/xhs-subtitle-coverage.mjs
```

`XHS_API_TOKEN` 必须非空。脚本自己会打印打了哪些端点、以及 24 小时免费的 `cache_url`——
复检时先看 `cache_url`，不要为了看一眼响应再花一次钱。

## 各文件

| 文件 | 打什么 | 测过什么 / 结论落在哪 |
| --- | --- | --- |
| `xhs-subtitle-coverage.mjs` | 2 次搜索 + 10 次详情 | 字幕覆盖率、语言轨道分布、「有字幕 × 有人声」交叉。用户结论：热门视频大部分带字幕。`opaque1.*` 字段名的出处 |
| `xhs-subtitle-content.mjs` | **免费**（只读 cache_url + CDN） | 字幕正文里有没有具体产品名。`.srt` 解析口径的出处（SSOT 第 2.3 节） |
| `xhs-subtitle-deixis.mjs` | **免费**（只读 cache_url + CDN） | 口播里「这一款」「这支」这类**产品指代**的占比。**结果没有留下来**，要判断这条线索能不能用就得重跑一次 |
| `xhs-video-probe{,2,3}.mjs` | 详情 + CDN | 播放直链、Range 支持、封面帧。画面路线已否决（规格附录 A） |
| `xhs-frame-probe.mjs` / `xhs-ocr-hunt.mjs` | CDN | 封面 URL 不按序号吐帧（`_1`/`_2`/`_100` 全 404）、OCR 抠画面文字的尝试。**附录 A.2 的证据** |
| `xhs-latency-probe.mjs` | 1 次搜索 + 3 次详情 | 各段延迟（搜索 / 详情并行 / 字幕 / 下载） |
| `pi-image-probe{,2}.ts` | 本地 mock，不打上游 | pi 三层是否支持扩展工具返回图片（结论：支持，唯一门禁是模型声明的 `input`） |

## 纪律

- 跑之前先想清楚这次要回答什么问题——详情是**按次计费**的。
- 打完就把 `cache_url` 记下来：24 小时内复检免费。
- **不要把签名 URL、`cache_url` 或 token 抄进仓库里的任何文档。** 搬家时已经剥掉了一批：
  只读 cache 的那几个脚本（`xhs-subtitle-content` / `xhs-subtitle-deixis` / `xhs-ocr-hunt` /
  `xhs-frame-probe` / `xhs-video-probe3`）里的 `?sign=` 全部换成了 `EXPIRED_REPLACE_ME`——
  **真签名会过期，抄下来只会误导下一个人**。要用就把当次响应里的 `cache_url` 原样粘进去，
  别提交。
