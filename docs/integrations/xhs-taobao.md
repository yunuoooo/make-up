# 小红书与淘宝接入说明

## 淘宝商品 API

妆迹优先使用淘宝客物料搜索接口补全 SKU 的价格、渠道和购买链接。

需要配置：

- `TAOBAO_APP_KEY`
- `TAOBAO_APP_SECRET`
- `TAOBAO_ADZONE_ID`
- `TAOBAO_API_ENDPOINT`，默认 `https://eco.taobao.com/router/rest`
- `TAOBAO_SIGN_METHOD`，默认 `md5`

兼容旧变量：

- `TAOBAO_API_KEY`
- `TAOBAO_API_SECRET`

当前实现调用 `taobao.tbk.dg.material.optional`。如果缺少 key、secret 或 adzone id，系统会继续返回淘宝搜索占位链接，不假装拿到实时价格。

## Vercel 临时存储

当前 MVP 的妆匣和工具运行日志仍是演示级 JSON 存储。本机默认写入 `.local-data`；Vercel 的运行目录不可写，因此会自动写到 `/tmp/looktrace-local-data`。

这只能保证接口不报错，不适合作为长期用户数据存储。真实用户版本应接 Supabase、Neon、Vercel Postgres 或其他数据库。

## 小红书来源模式

`XHS_SOURCE_MODE` 支持：

- `mock`: 默认模式，使用人工种子和稳定 mock 数据。
- `local_browser`: 本机小红书账号辅助搜索。只适合本机内测，不适合 Vercel 生产环境。
- `official_api`: 预留官方或商务 API 接入点。

### 本机账号辅助搜索

1. 运行：

   ```bash
   npm run xhs:browser
   ```

2. 在打开的专用浏览器里登录小红书。

3. 在本机 `.env` 里设置：

   ```bash
   XHS_SOURCE_MODE="local_browser"
   XHS_LOCAL_BROWSER_DEBUG_URL="http://127.0.0.1:9222"
   ```

4. 保持这个浏览器窗口开着，再使用妆迹聊天。

这个模式不会把小红书密码、验证码或 Cookie 写入代码，也不上传到 Vercel。登录态只保存在本机 `.local-data/xhs-browser-profile`，该目录已被 `.gitignore` 忽略。

### 官方 API 预留

如果后续拿到小红书官方或商务侧搜索/笔记读取 API，可设置：

```bash
XHS_SOURCE_MODE="official_api"
XHS_OFFICIAL_API_BASE_URL="https://..."
XHS_OFFICIAL_API_KEY="..."
```

当前预留契约为：

```http
POST {XHS_OFFICIAL_API_BASE_URL}/search
Authorization: Bearer {XHS_OFFICIAL_API_KEY}
Content-Type: application/json
```

请求体：

```json
{
  "query": "低饱和 雾面 通勤 妆容拆解 产品清单 SKU",
  "conversationId": "conv_xxx"
}
```

响应建议返回：

```json
{
  "sources": [
    {
      "title": "笔记标题",
      "author": "作者",
      "sourceUrl": "https://...",
      "rawText": "正文",
      "summary": "摘要"
    }
  ]
}
```
