# 妆匣：把用户已有的化妆品变成推荐的输入

Status: **Implemented（2026-10-16）**——读路径、预设播种、粘贴导入、技能接入都已落地；预设**内容**为空、`KIT_PRESET_ENABLED` 默认关闭，真起 pi 进程的两条链路未验证（见第 13 节）
Date: 2026-10-16
Related specs: [001-mvp.md](./001-mvp.md)（妆匣的原始定位、字段与 API 草案）· [09-17-pi-skill-runtime.md](./09-17-pi-skill-runtime.md)（技能加载链路，本文扩到两个技能）· [09-21-taobao-product-cards.md](./09-21-taobao-product-cards.md)（`looktrace-products` 块与商品卡片，**本文只要求它保留，不改它**）· [09-24-tikhub-xhs-ssot.md](./09-24-tikhub-xhs-ssot.md)（取数端点，本文只引用）

## 0. 文档目的

妆匣今天**只有一半，而且关着门**：录入、编辑、删除、存储、API 全都是通的，被 `IS_LIBRARY_OPEN` 挡在「暂未开放」占位后面；而 Agent **完全读不到它**（第 2 节）。后果是当前每一条 `✅` 都只是模型的口头承诺——`xiaohongshu-makeup-advisor-latest/SKILL.md:38-45` 要求「`✅` 表示用户已经明确确认拥有该具体单品」，但运行时里没有任何东西能支撑这句话。

本文定义三件事：

1. **读的契约**：Agent 怎么拿到妆匣，拿到什么，拿不到时怎么如实说。
2. **妆匣怎么填**：手动录入、粘贴淘宝购买记录、以及没有录入时的预设妆匣。
3. **特点（属性）怎么定**：一件化妆品「适合什么」在录入时判断出来，与妆容需求侧**共用一套词**，这是复用判断真正能成立的前提。

**本文不定义**：妆匣的字段与存储（归 `lib/types/domain.ts:1-20` 与 [001-mvp.md](./001-mvp.md) 4.5 节，本文只新增可选字段）· 上游端点与字段（归 [09-24-tikhub-xhs-ssot.md](./09-24-tikhub-xhs-ssot.md)）· `looktrace-products` 的格式与卡片链路（归 [09-21-taobao-product-cards.md](./09-21-taobao-product-cards.md)）· 匹配逻辑本身（归技能，见第 8 节）。

## 1. 决策（2026-10-16）

| # | 决策 | 理由 |
| --- | --- | --- |
| 1 | **预设妆匣播种进用户妆匣**，`status: "owned"`，Agent 当持有处理并正常标 `✅` | 空妆匣下「复用已有品」这条主路径演示不出来。落库而不是让模型假装：`makeup-kit/SKILL.md:17` 要求持有候选必须是「用户声明**或其妆匣记录确认持有**」，落库后这条**字面成立** |
| 2 | **粘贴导入只吃纯文字**：不做截图、不做 OCR、不接视觉 | 当前 `PI_MODEL=deepseek-chat` 无视觉（[09-25 附录 A.2](./09-25-video-understanding.md)）。引入视觉是独立的一块依赖，违反「取数不需要任何二进制」 |
| 3 | **advisor 技能升级但保住两个契约**：恢复 `looktrace-products` 块、保留「色号待试」 | 上游新版删了商品块——那是 `lib/commerce/product-block.ts` 的**唯一输入**，删了商品卡片静默消失（第 8.2 节） |
| 4 | **打开妆匣 Tab**（`IS_LIBRARY_OPEN → true`），录入必填收敛为「品类 + 品牌」 | 门是 `7bf70b5` 预留的恢复开关，代码原地保留；必填对齐 `makeup-kit` 的三项录入，但工具类产品本就没有色号（`input-contract.md:21` 允许写「不适用」），设必填会挡住正当录入 |
| 5 | **特点在录入时判断**：与导入解析同一次调用产出，标 `model-inferred`；用户可一键修正 | Agent 只读、不能写回（决策 6），所以它每轮现研究的属性**沉淀不下来**——同一支口红这轮判「正红哑光」、下轮判「偏砖红」，用户看到两次不一致而两次都没有记录 |
| 6 | **Agent 检索核实到的属性不回写妆匣** | `makeup-kit/SKILL.md:19` 明写「不把新推荐自动写回文件或产品 tab」。代价见第 12.3 节 |

**决策 1 的直接后果**：预设套件里每一条都必须是**真实可核实的商品**。Agent 会把它当作「用户实际持有」讲出来，编造的色号会变成一句「你已经有了这支口红」的假话——比空库更糟。第 5.2 节把这条写成硬约束。

**决策 5 的直接后果**：需求侧与能力侧**必须共用一套属性词**（第 7.2 节）。技能要求「把诉求推导为产品需求」再「比较已知产品与推导需求」；如果妆匣这边写「遮盖力高」而妆容那边推导出「浓妆底妆」，两侧对不上，匹配还是只能靠模型自由心证——录入时判断就白做了。

## 2. 现状

### 2.1 已经在的（但关着门）

| 层 | 位置 | 状态 |
| --- | --- | --- |
| 类型 | `lib/types/domain.ts:1-20` | 已有 `brand`/`name`/`category`/`shade`/`colorFamily`/`finish`/`texture`/`effectTags`/`status` |
| 存储 | `lib/storage/user-products.ts` | 完整 CRUD；`listUserProducts` 已过滤 `status !== "retired"`（`:23`），与技能「用完不算持有」一致 |
| API | `app/api/user-products/route.ts`、`[id]/route.ts` | GET/POST/PATCH/DELETE 全通 |
| 界面 | `frontend/hooks/useBeautyKit.ts`、`components/beauty-kit/*` | 录入、编辑、删除、搜索、品类筛选全部实现 |
| 门 | `frontend/lib/constants.ts:10` | `IS_LIBRARY_OPEN: boolean = false`，5 个读取点全在 `AdvisorApp.tsx`（`:60`、`:61-63`、`:156`、`:251`、`:279`） |

两个容易漏看的事实：

- `useBeautyKit` **照常挂载并发 GET**（`AdvisorApp.tsx:56`、`useBeautyKit.ts:35-39`），服务端写接口也一直是活的——只有界面被挡。
- `.local-data/` 里**没有** `user-products.json`，`readJson(fileName, [])` 永远从空库起步。

### 2.2 缺的四件

1. **Agent 读不到妆匣。** `app/api/chat/route.ts` 完全忽略 `userId`，`runPiAgent` 拿不到任何用户身份（`route.ts:156-161`）。`.pi/extensions/` 里只有 `xhs-source.ts`，没有妆匣工具。
2. **没有匹配引擎，也不该有。** `OwnedProductMatch`（`lib/types/domain.ts:100-108`）是**死类型**：全仓库只有定义和 `AgentAnswer` 上的一个字段，没有任何生产者或消费者；`AgentAnswer`/`SearchPlan`/`SkuCandidate` 等同批类型同样未被引用（活的前端走 `frontend/lib/types.ts` 的另一套）。[001-mvp.md:735-737](./001-mvp.md) 规划过 `searchUserProducts`/`matchOwnedProducts`/`composeAnswer`，从未实现。**本次不实现**（附录 A.3）。
3. **需求侧与能力侧没有共用的属性词表。** `makeup-kit/references/categories.md` 只统一了**品类**；属性（妆效、遮盖力、妆感浓淡）没有词表，`UserProduct.effectTags`（`domain.ts:14`）是自由标签。两侧各说各话，比对就只剩模型心证。
4. **妆匣相关零测试。** `test/` 里 grep `user-products|UserProduct|beauty` 零命中。存储层、API、`useBeautyKit`、`ProductDialog` 都没有回归覆盖。

### 2.3 上游技能包：新的是 makeup-kit，但它是给 Codex 写的

微信收到的 `makeup-skills.zip` 含三个技能：`makeup-kit`（新）、`xiaohongshu-makeup-advisor`（**比仓库版本新**，已集成妆匣条款）、`tikhub-xhs-video-reader`。前两个要接，第三个整包不收（附录 A.1）。

它是**为 Codex 写的**：技能正文让模型 `node <skill-dir>/scripts/*.mjs`，妆匣读用户给的 `memory.md`，还带 `agents/openai.yaml`。三处与仓库现状冲突：

| 冲突 | 上游写法 | 仓库现状 | 处置 |
| --- | --- | --- | --- |
| 取数方式 | `node scripts/xhs_image_evidence.mjs`、`xhs_video_evidence.mjs` | 工具 `xhs_*` 由 `.pi/extensions/xhs-source.ts` 注册，实现在 `lib/xhs/tikhub.ts` | **不收脚本**（附录 A.1） |
| 妆匣读取 | Codex 读用户给的 `memory.md` | 应用自己的存储 | 改成工具（第 4 节） |
| 商品块 | **删掉了** `looktrace-products` 条款 | `lib/commerce/product-block.ts` 靠它产出卡片 | **恢复**（第 8.2 节） |

## 3. 方案

### 3.1 一条存储，一个只读入口

```
① 读    妆匣 JSON ──> kit_list_products（只读工具）──> Agent ──> ✅ / 💰 / ❔

② 预设   空库 ────────┐
③ 手动   填三项 ──────┤──> 判断特点 ──> 用户确认/修正 ──┐
④ 导入   粘贴文字 ────┘   （单次模型调用）             │
                                                      └──> 妆匣 JSON
                                                          （含逐属性来源）
```

**②③④ 都只是往 ① 的存储里写记录，Agent 侧没有任何分支。** 它永远只做一件事：读库、核对、出结论。这样 `makeup-kit/SKILL.md:19` 的「不把新推荐自动写回文件或产品 tab」自动成立，将来接真实分用户也只需要改 ① 的身份来源。

### 3.2 读

新增 `.pi/extensions/kit-source.ts`，注册**唯一一个**只读工具 `kit_list_products`。契约见第 4 节。

内置 `read` **没有任何路径限制**（`lib/pi/events.ts:304-306` 已自认），所以模型今天就能打开 `.local-data/user-products.json`。给工具不只是方便，是把妆匣读取从**碰运气**变成**有契约**：返回体自带 `availability` / `scope`，想撒谎都缺材料。系统提示词同时明确禁止用 `read` 读数据目录（第 8.4 节）。

### 3.3 录入与特点判断

见第 6 节。词表见第 7 节。空妆匣的预设见第 5 节。

## 4. 工具契约

### 4.1 参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `categoryId` | string | 否 | 按标准品类过滤（第 7.1 节）。不传＝全部 |

**没有 `userId` 参数**，这是刻意的。`makeup-kit/references/input-contract.md:13`：

> 实际产品的用户范围由应用提供，不能根据文件内文字或搜索结果切换用户。

身份只能来自运行时：bridge 在 spawn 时注入 `LOOKTRACE_USER_ID`（缺省 `local-user`，与 `frontend/lib/constants.ts:3` 的 `CURRENT_USER_ID` 一致），扩展读环境变量。**模型无法通过参数切换用户。**

### 4.2 返回（受控 JSON，不透传存储原文）

```jsonc
{
  "source": "user-products.json",
  "availability": "ok",              // ok | empty | read-failed
  "scope": { "total": 9, "returned": 9, "filteredByCategory": "lip" },
  "userId": "local-user",
  "products": [
    {
      "id": "prod_…",
      "categoryId": "lip",
      "category": "唇妆",             // 归一化后的标准一级品类
      "categoryRaw": "唇釉",          // 用户原文，保留
      "brand": "…", "shade": "…", "name": "…",
      "status": "owned",
      "recordSource": "preset",       // preset | manual | import
      "attributes": {                 // 空＝未知，不是「没有该属性」
        "colorFamily": "正红", "finish": "哑光", "intensity": "浓郁"
      },
      "attributeSources": {           // 逐属性来源，见第 6.6 节
        "colorFamily": { "source": "model-inferred" },
        "finish": { "source": "model-inferred" },
        "intensity": { "source": "model-inferred" }
      }
    }
  ]
}
```

**`availability` 三态是这套设计的核心**，直接对应 `makeup-kit/SKILL.md:18` 要求区分的三种情况：

| 值 | 含义 | 模型必须怎么说 |
| --- | --- | --- |
| `ok` | 成功读到记录 | 按记录核对 |
| `empty` | **成功读取，但这个用户的妆匣是空的** | 「妆匣未记录该品类」——**不能说「你没有某能力」** |
| `read-failed` | 读取失败 | 「本轮没取得妆匣数据」，购买判断保留为条件候选 |

`empty` 与 `read-failed` **必须分开**。混成一个，模型就会把「没读到」说成「你没有」，这正是 `makeup-kit/SKILL.md:18` 要防的失败模式。

**`intensity`（妆感浓淡）由服务端算好返回**，不让模型换算——与 `postedAt` 的处理同理（[09-25 第 3.3 节](./09-25-video-understanding.md)：时间戳由服务端格式化好，不让模型做换算）。派生规则见第 7.2 节。

### 4.3 拒绝语义（预期内结果，**return** 不 throw）

沿用 `xhs-source.ts` 的 `refusal()` / `{reason, message}` 形态与 `blocked()` 闸门；真故障才 throw。

| 情形 | `reason` | 前端文案（加进 `lib/pi/events.ts:211` 的 `REFUSAL_LABELS`） |
| --- | --- | --- |
| 成功读到空库 | `kit-empty` | 妆匣还没有记录 |
| 存储读取异常 | `kit-read-failed` | 妆匣没读到 |
| `categoryId` 不是标准品类 | `bad-argument` | 参数不完整（复用现有条目） |

`summarizeToolCall` / `summarizeToolResult`（`lib/pi/events.ts:189`、`:227`）各加一个 case，否则前端过程区只显示裸工具名。建议：调用显示「核对妆匣」（带品类时「核对妆匣｜唇妆」），结果显示「妆匣 9 件，唇妆 3 件」。

### 4.4 扩展的导入约束（会让实现踩坑）

pi 用 jiti 加载扩展，**只 alias 了 pi 自己的包**——仓库的 `@/*` 别名在扩展里解析不了（`xhs-source.ts:3-4` 用相对路径正是为此）。

- `lib/storage/json-store.ts` 只 import node 内置模块，**已经可以直接被扩展使用**。
- `lib/storage/user-products.ts:1` 目前是 `@/lib/storage/json-store`，**要改成 `./json-store`**。`:2` 是 `import type`（会被擦除），`lib/types/domain.ts` 无 import，都不用动。

改动极小，但漏了是**运行时**才炸，且报错是模块解析失败、不指向妆匣。

## 5. 预设妆匣

### 5.1 播种与幂等

```
GET /api/user-products
  └─ ensurePresetSeeded(userId)          // lib/kit/preset.ts
       ├─ kit-state.json 里 presetSeeded[userId] === true → 直接返回
       ├─ 妆匣非空 → 记标记，不播种（用户已经自己录了）
       └─ 妆匣为空 → 写入 preset 条目 → 记标记
```

**必须用独立标记文件，不能只看「库空不空」**：用户清空预设之后库又是空的，只看库会**再播一次**，用户会以为删除失效。`kit-state.json` 与 `user-products.json` 同目录（`lib/storage/json-store.ts:8-10` 的 `dataDir()`），随 `LOOKTRACE_DATA_DIR` 一起走。

生产上 `.local-data` 在发布树外面（`/srv/make-up-shared/.local-data`），所以**每次发版都不会重播**——标记跟着用户数据走。

开关 `KIT_PRESET_ENABLED`（默认 `true`）。关掉＝不播种，`kit_list_products` 返回 `empty`，整条链路如实降级。

### 5.2 ⚠️ 内容硬约束：必须是真实商品

因为决策 1 让 Agent 把它们当作**用户实际持有**并标 `✅`，任何一条编造的商品都会变成一句假话。所以：

- 品牌、产品线、色号必须能在品牌官网或可靠零售页查到。
- 选**长寿款经典色**，不选当季联名或易停产款——预设会长期躺在用户妆匣里，停产即失效。
- 覆盖 `base`、`lip`、`blush`、`eyeshadow`、`brow`、`mascara`、`setting` 七个品类，每类 1–2 件，**总 8–12 件**。目标是让一次典型妆容的复用判断跑得起来，不是凑数量。
- **`base` 不放粉底色号**：色号强依赖个人肤色，预设里给一个「属于用户」的粉底色号在语义上就是错的。放妆前乳这类弱色号品类。
- 色号要明确好核对（优先有官方色号的），避免需要再拆格色的多色盘。
- 特点按第 7.2 节的词表逐条填，来源标 `search-verified`——这是唯一会产生该来源的地方（第 6.6 节）。**不写营销话术。**

具体选品是内容工作，需要逐条核实（第 12.1 节）。**核实完成前 `KIT_PRESET_ENABLED` 保持关闭**，否则就是把编造的商品当成用户持有。

### 5.3 界面

- 库里只要还存在 `recordSource === "preset"` 的条目，妆匣 Tab 顶部显示可关闭提示条：「**示例妆匣**：这些是预设的常见单品，不是你的化妆品。改成你的，或一键清空。」
- 两个动作：`清空示例`（删掉全部 preset 条目）、`保留并编辑`（逐条改）。
- 单个卡片上给 preset 条目一个小标记。用户编辑某条 preset 条目后 `recordSource` 改为 `"manual"`（视为认领）。

## 6. 录入：手动、导入、以及特点判断

### 6.1 三条录入路径

| 路径 | 一次几件 | 特点怎么来 |
| --- | --- | --- |
| 手动 | 一件 | 保存后自动判断（第 6.3 节） |
| 粘贴购买记录 | 一批 | 与解析同一次调用产出（第 6.4 节） |
| 预设播种 | 8–12 件 | 策展时逐条核实（第 5.2 节） |

三条路径写同一个存储、同一套字段、同一套词表（第 7 节）。

### 6.2 为什么在录入时判断

Agent 是**只读**的：`makeup-kit/SKILL.md:19` 不允许它写回妆匣，决策 6 也确认不回写。所以**凡是它每轮现场研究的属性，永远沉淀不下来**。后果不是「慢一点」，是**跨轮不一致**：同一支口红，这轮判「正红哑光」、下轮判「偏砖红」，用户看到两次不同的答案，而两次都没有记录可以对照。

录入时判一次、落库、带逐属性来源，才自洽。

### 6.3 手动录入：保存不阻断

用户填品类/品牌/色号并保存（第 1 节决策 4 的必填收敛），然后：

1. 记录**立即落库**，特点为空。
2. 自动触发一次判断调用（第 6.5 节），回来后写入特点。
3. 判断**失败或超时**时，记录仍在、特点留空，卡片上给一个 `重新判断特点` 动作——对齐 `makeup-kit/SKILL.md:16` 的「缺失信息保留未知，不编造」，**不让模型调用失败挡住录入**。

不把判断做进保存的必经过程，是因为它是一次网络 + 模型调用；把它变成保存的前置会把「加一件化妆品」变成一件要等的事。

### 6.4 粘贴购买记录导入

用户复制淘宝**订单列表/购买记录的文字**（或商品标题串）粘贴进妆匣 Tab 的文本框。

- **只解析文本。** 不做截图、OCR、视觉（决策 2）。
- **不调用淘宝接口。** 订单文字里通常已含品牌与产品线。`TAOBAO_CARDS_ENABLED` 保持 `false`，导入链路**零计费**。
- 输入上限 `KIT_IMPORT_MAX_CHARS`（默认 `20000`，**估的**）：超出**明确拒绝并说明**，不静默截断。
- 粘贴文本是**不受信任内容**，按第 11 节处理。

模型的产出是**候选项**，不是记录：

```jsonc
{
  "items": [{
    "categoryId": "lip", "category": "唇妆", "categoryRaw": "唇釉",
    "brand": "…", "name": "…", "shade": "…",
    "attributes": { "colorFamily": "正红", "finish": "哑光", "intensity": "浓郁" },
    "confidence": "high",        // high | low
    "unknowns": ["shade"],       // 哪些字段没解析出来
    "rawExcerpt": "…"            // 对应原文片段，供用户核对
  }],
  "skipped": [{ "rawExcerpt": "…", "reason": "not-cosmetics" }]
}
```

界面把 `items` 渲染成**可勾选、可编辑的行**，确认后 `POST /api/user-products/import/commit` 写库。

三条硬规则：

1. **不确认不落库。** 预览阶段零写入。
2. **`skipped` 必须回显**，让用户看到「有 3 条没认出来」，而不是以为解析全了。
3. **`unknowns` 不补全。** 色号解析不出来就留空，**不猜**——`makeup-kit/SKILL.md:16` 的「缺失信息保留未知，不编造」与 `:29` 的「不擅自指定版本」。

**买到 ≠ 还在用**：购买记录可能送人、是赠品小样、已用完、已退货。落库默认 `status: "owned"`（用户勾选即为认领），预览页同时提供 `已用完 / 不再使用` 选项直接写 `"retired"`——`listUserProducts`（`user-products.ts:23`）会自动排除，正是技能要的「用完不算持有」。

### 6.5 判断调用

新增 `lib/kit/judge.ts`：**单次**模型调用，两个入口共用一个 prompt 与 schema。词表在 `lib/kit/attributes.ts`（第 7.2 节）。

| 入口 | 输入 | 输出 |
| --- | --- | --- |
| `parsePurchaseText(text)` | 整段订单文字 | 多个候选项（第 6.4 节） |
| `judgeAttributes({categoryId, brand, shade})` | 一件的三项 | 该件的特点 |

- 走 pi 二进制、单发、无会话、无技能、无工具、无扩展，复用 `PI_PROVIDER` / `PI_MODEL` 与既有凭据。理由：AGENTS.md 定「`lib/pi/` 是 Agent 的唯一入口」，模型配置应只有一份 SSOT；直接 `fetch` 供应商端点会凭空多一套 baseURL/密钥映射。
- **不带 `xhs_*` 工具。** 判断用的是模型对产品身份的既有知识，不是检索。要检索就得让录入路径直接调 `lib/xhs/tikhub.ts`，那会绕过扩展里的预算与详情上限闸门；每件至少一次计费调用，导 12 件就是十几次——**否决，见附录 A.5**。
- 要求**只输出 JSON**，不接受散文。一件一次调用（手动路径），一批一次调用（导入路径）。
- 超时 `KIT_IMPORT_TIMEOUT_SECONDS`（默认 `60`，**估的**）。超时/上游失败 → 手动路径降级为「特点留空」（第 6.3 节），导入路径明确报错不写库。

调用的确切形态（`--mode json` 的输出怎么取、`--no-session` 下是否干净）**待实测**，见第 12.6 节。

### 6.6 逐属性来源：特点有多可信

判断产出的是**模型从产品身份推断**的特点，比检索核实弱一档。两者混为一谈，模型就会把「猜的」当「查到的」讲给用户。所以**来源要逐属性记，不能一条记录一个**——「色号」是查得到的事实，「浓妆还是淡妆」是对这一件能不能用的判断，可信度不同：

| `source` | 什么时候产生 |
| --- | --- |
| `user` | 用户填写或一键修正过该属性 |
| `model-inferred` | 录入时模型判断（第 6.5 节） |
| `search-verified` | **只由预设策展产生**（第 5.2 节，离线按官方页核实）。运行时不产生——决策 6 不回写 |

存储上落在 `UserProduct.attributeSources?: Record<string, { source: string; at?: string }>`，键是属性名。用户改某个属性 → **只**该键转 `user`，其他属性不动（第 10.1 节有对应回归）。

**Agent 侧**：`model-inferred` 的特点是**线索不是结论**。技能要求的检索核实仍是必经步骤（`makeup-kit/SKILL.md:28` 的 `<品牌> <具体品类> <色号> 试色 妆效`），核实结果**只在本轮答案里体现，不写回**（决策 6）。所以这个线索每轮都要重新核实一遍——这是决策 6 的已知代价，记在第 12.3 节。

### 6.7 入口

妆匣 Tab 加「粘贴购买记录导入」，与「手动添加一件」并列。导入是**批量**路径，手动是**单件**路径。

## 7. 品类与属性：需求与妆匣共用的词表

### 7.1 品类映射

`makeup-kit/references/categories.md` 定义 `categoryId ↔ 中文一级品类`，并明确要求「不在两个入口分别维护不一致的分类表」。它点名对齐了 `frontend/lib/constants.ts:13-26` 的 `CATEGORY_OPTIONS`（12 个中文名）。这个映射有三个消费者（前端筛选、扩展归一化、技能文本），必须只有一份数据：

- 新增 `lib/kit/categories.ts`：`{ categoryId, name, aliases[] }`，**零 `@/` 依赖**（扩展要用，第 4.4 节）。
- `frontend/lib/constants.ts` 的 `CATEGORY_OPTIONS` 改为从它派生，**保持导出名与顺序不变**（筛选与历史数据依赖顺序）。
- 技能文本保留别名表——它要处理用户自由输入的别名，那是它的职责；`categoryId` 与中文名以 `lib/kit/categories.ts` 为准，技能里注明出处。

12 个 `categoryId` 沿用上游：`base / concealer / setting / brow / eyeshadow / eyeliner / mascara / blush / contour / highlight / lip / tools`。

归一化放服务端（扩展与导入共用同一函数），**不靠字符串相等**匹配（`categories.md` 使用规则第 6 条）。未知品类保留为待归类候选，不丢弃。

### 7.2 属性词表：为什么它是这套设计的地基

技能的两侧都要说「特点」：

- **需求侧**（advisor 研究妆容得出）：「底妆：**浓郁**、雾面」「唇妆：**浓郁**正红」
- **能力侧**（妆匣里这一件）：「遮盖力 **高**、妆效 雾面」

两侧现在是自由文本（第 2.2 节第 3 条）。**不统一词表，录入时判断就白做**——「浓妆底妆」和「遮盖力高」对不上，模型只能重新自由发挥。所以属性词表和品类映射同级，都是 `lib/kit/` 里的 SSOT。

#### 两类属性

| | 是什么 | 例子 | 主要来源 |
| --- | --- | --- | --- |
| **身份属性** | 由产品身份（品牌+产品线+色号）决定，查得到 | 色系、质地 | 品牌页、试色 |
| **能力属性** | 这一件**能做到什么**，是复用判断的判据 | 遮盖力、妆效、持妆、防水 | 前者的推论 + 用户确认 |

#### 逐品类的决定性维度（取值是闭集）

| `categoryId` | 决定性维度 |
| --- | --- |
| `base` | 遮盖力 清透/中等/高 · 妆效 雾面/半哑光/水光 · 持妆 一般/持久 |
| `concealer` | 遮盖力 清透/中等/高 · 妆效 雾面/水光 |
| `setting` | 妆效 哑光/微光 · 控油 弱/中/强 |
| `brow` | 色系 灰/棕/黑/红棕 · 形态 笔/粉/膏 |
| `eyeshadow` | 色系 · 妆效 哑光/珠光/大闪 · 显色度 清透/中等/浓郁 |
| `eyeliner` | 色系 黑/棕/其他 · 形态 笔/液/胶 · 防水 是/否 |
| `mascara` | 结构 纤长/浓密/卷翘 · 防水 是/否 |
| `blush` | 色系 · 质地 粉/膏/液 · 显色度 清透/中等/浓郁 |
| `contour` | 色温 冷/暖/中性 · 质地 粉/膏 |
| `highlight` | 色温 冷/暖/中性 · 妆效 细闪/大闪/湿光 |
| `lip` | 色系 · 妆效 哑光/缎光/镜面/水光 · 显色度 清透/中等/浓郁 |
| `tools` | 自由（不参与妆效比对） |

#### 妆感浓淡是**派生**维度，不是独立字段

「这件底妆是浓妆的还是淡妆的」是需求侧最自然的说法，也是产品上最想表达的东西。但它**不能作为一个独立字段存**——否则「遮盖力 = 高」和「浓淡 = 淡妆」会同时存在并且互相矛盾。

所以它由决定性维度**按规则派生**，两侧用同一条规则：

| `categoryId` | 清透 | 日常 | 浓郁 |
| --- | --- | --- | --- |
| `base` | 遮盖力 清透 | 遮盖力 中等 | 遮盖力 高 **且** 妆效 雾面或持妆持久 |
| `lip` | 显色度 清透 | 显色度 中等 | 显色度 浓郁 **且** 妆效 哑光或镜面 |
| 其余同构 | 逐品类规则写在 `lib/kit/attributes.ts` | | |

派生值**不落库**（避免上面那种矛盾），但**由服务端算好返回**（第 4.2 节的 `intensity`），也让需求侧用同一条规则归一——于是「浓妆底妆」这个需求和「遮盖力 高 · 妆效 雾面」这件已有品落在同一个档位上，可以被比较而不是被发挥。

**判定以决定性维度为准**：`intensity` 与维度不一致时（比如维度后来被用户改了），重算 `intensity`，不改维度。

#### 其余约定

- 缺失＝**未知**，不是「没有该属性」。未知照旧不编造（`makeup-kit/SKILL.md:16`）。
- 闭集里没有的取值**保留原文**写进 `effectTags`（现有自由标签字段，`domain.ts:14`，不动），但**不参与**妆效比对——闭集才能比对。
- 闭集里的取值必须能同时对两侧有意义。加一个取值进闭集，等于承诺需求侧也能说出来。

### 7.3 SSOT 落点

| 文件 | 内容 | 谁用 |
| --- | --- | --- |
| `lib/kit/categories.ts` | `categoryId` + 中文名 + 别名 | 扩展、导入、前端筛选、技能文本（注明出处） |
| `lib/kit/attributes.ts` | 逐品类维度 + 闭集取值 + `intensity` 派生规则 | 判断调用、工具返回、前端展示、技能文本（注明出处） |

两个文件都**零 `@/` 依赖**（扩展要用）。技能文本里保留可读的对照表，但注明以这两个文件为准——和 `categories.md` 现在点名 `CATEGORY_OPTIONS` 是同一个做法。

## 8. 技能改动条款

### 8.1 引入 `makeup-kit`

新增 `makeup-kit/`，**仓库根目录、与 `xiaohongshu-makeup-advisor-latest/` 平级**，含 `SKILL.md` + `references/{input-contract,categories,matching-cases}.md`。

平级不是随意的：上游技能正文用 `../makeup-kit/SKILL.md` 相互引用，平级才能让这个相对路径**在磁盘上真的成立**（相对路径按 SKILL.md 所在目录解析，见 [09-17](./09-17-pi-skill-runtime.md) 第 3 节）。

**必须改写**（其余照搬上游）：

1. **妆匣读取入口。** 上游有「Codex 模拟读 `memory.md`」与「实际产品由应用提供」两种形态，仓库只有后者。删掉 `SKILL.md:14` 的 Codex 段与 `references/input-contract.md` 的「Markdown 模拟输入」整节，改成：**妆匣一律通过 `kit_list_products` 读取**，按返回的 `availability` 区分三态，不假定存储格式、不用 `read` 读 `.local-data`。
2. **保留**「不能仅凭旧回复或聊天摘要说已经看过」（`SKILL.md:25`）——它防的是模型偷懒，与数据来源无关。
3. **属性用共用的词表。** `SKILL.md:29` 现在只说「按已核实的产品常规颜色与妆效对照第 2 步的需求」，改成引用第 7.2 节的维度与闭集取值，并明确：妆匣里 `model-inferred` 的特点是**线索**，决定性属性仍要按 `:28` 检索核实，核实结果**不写回**。
4. **三项录入 vs 现有字段。** 按决策 4 收敛**必填**为品类/品牌。
5. 不收 `agents/openai.yaml`（Codex 打包文件）。
6. 不收上游 `scripts/`（附录 A.1）。
7. 全量保留诚实条款、`✅/💰/❔` 三态与 `references/matching-cases.md` 的判例——那是这个技能的全部价值。

### 8.2 升级 advisor：三方合并

采纳上游新条款 + 保住仓库契约。

**采纳**：`SKILL.md` 的妆匣前置条款（上游 `:12-16`）、`## 统一品类` 表、`🎙️/🎬/🖼️/🧩/↔️` 五级证据标记、视频口播覆盖检查、「视频提及但未采用」短节；`references/happy-path.md` 的流程加入「读妆匣 → 核实已有 SKU → 定复用与缺口」、个性化邀请改为「只问变化，不要求重复列已保存妆匣」；`references/research-method.md` 的研究记录四项与图片组检查。

**目标特点用同一套词**（第 7.2 节的直接落地）：advisor 在第 2 阶段把诉求推导为产品需求，产出的「目标特点」和「用什么达成」两列里，出现妆效、遮盖力、妆感浓淡这类词时**必须用第 7.2 节的维度名与闭集取值**。否则需求侧说「浓郁」、能力侧说「高遮盖」，第 7.2 节的词表就是单边的。

**拒绝**：

| 上游改动 | 处置 | 原因 |
| --- | --- | --- |
| 删掉 `looktrace-products` 机器可读商品块 | **恢复** | `lib/commerce/product-block.ts` 是卡片的唯一输入；删了 `attachProductCards`（`app/api/chat/route.ts:33-92`）拿不到任何 item，卡片静默消失 |
| 「内部选定肤色基准 → 给具体色号（参考）」 | **保留仓库的「色号待试」** | 不给无试色依据的绝对色号是现行策略（`SKILL.md:46`、`happy-path.md:44`） |
| `node scripts/*.mjs` 调用方式 | **改 `xhs_*` 工具** | [09-17 第 5 节](./09-17-pi-skill-runtime.md)的「约束跟着有缺陷的那个工具走」 |
| description 里点名 TikHub | 改回工具口径 | 描述里点名供应商会把实现焊进技能 |

商品块**原样留下**：`looktrace.products.v1`、五个字段（`category`/`brand`/`name`/`shade`/`section`）、只列 `💰` 首选、每品类最多一条、消息最末尾唯一一个（`SKILL.md:65-76`、`happy-path.md:36-42,91`）。

> 这一条要单独写成测试断言把技能文本钉住（第 10.1 节）——上游下次升级同样会把它删掉，我们要的是**测试失败**而不是**卡片静默消失**。

### 8.3 多技能加载

`lib/pi/bridge.ts` 假设**只有一个技能**：`DEFAULT_SKILL_PATH`（`:68`）是单路径、`resolveSkillPath`（`:74-76`）返回单个、`buildPiArgs` 传单个 `--skill`（`:116`）。

pi 支持重复的 `--skill`（`cli/args.js:142-145` 累积进数组，帮助文本写明 "can be used multiple times"），`--no-skills` 下只认 CLI 路径。所以：

- `resolveSkillPath` → `resolveSkillPaths`，返回数组，默认 `["xiaohongshu-makeup-advisor-latest", "makeup-kit"]`。
- `buildPiArgs` 展开成多个 `--skill`。
- `PI_SKILL_PATH` **保持单数语义**（覆盖主顾问路径，向后兼容 `.env.example` 与部署文档），新增 `PI_SKILL_PATHS` 用于完全覆盖。
- 启动前的 `SKILL.md` 校验（`:261-272`）改为**逐个**校验。缺一个就起不来——比静默少加载一个技能好。
- `scripts/preflight.mjs` 同步校验两个目录（它是 `deploy.sh` 与 `deploy-remote.sh` 共用的校验，AGENTS.md 明说不要各抄一份）。

两个技能都会进 `<available_skills>`（pi 只给 name/description/location，模型自己 `read` 加载）。这是想要的：用户直接问「我有什么能用」时，模型能自己找到 `makeup-kit`，不必等主顾问转述。

### 8.4 系统提示词与白名单

`DEFAULT_SYSTEM_PROMPT`（`bridge.ts:57-61`）改两处：

1. 工具清单加 `kit_list_products`（只读妆匣）。
2. `read` 的用途从「技能目录内的 SKILL.md、references/ 和 scripts/」扩到**两个技能目录**，并加一句：**妆匣内容一律通过 `kit_list_products` 读取，不要用 `read` 打开 `.local-data` 下的数据文件。**

`READ_ONLY_TOOL_ALLOWLIST`（`:66`）加 `kit_list_products`。

## 9. 全仓库改动清单

| 层 | 文件:行 | 改什么 |
| --- | --- | --- |
| 技能 | **新** `makeup-kit/SKILL.md` + `references/*` | 按第 8.1 节改写 |
| 技能 | `xiaohongshu-makeup-advisor-latest/SKILL.md`、`references/happy-path.md`、`references/research-method.md` | 按第 8.2 节三方合并；目标特点改用第 7.2 节词表 |
| 运行时 | `lib/pi/bridge.ts:57-61` | 系统提示词：加工具、扩 `read` 用途、禁止读 `.local-data` |
| 运行时 | `lib/pi/bridge.ts:66` | 白名单加 `kit_list_products` |
| 运行时 | `lib/pi/bridge.ts:68,74-76,116` | 单技能 → 多技能（第 8.3 节） |
| 运行时 | `lib/pi/bridge.ts:261-272` | 逐个校验 `SKILL.md` |
| 运行时 | `lib/pi/bridge.ts:293` | spawn 的 `env` 里注入 `LOOKTRACE_USER_ID` |
| SSE | `lib/pi/events.ts:189,227` | `summarizeToolCall`/`summarizeToolResult` 加妆匣 case |
| SSE | `lib/pi/events.ts:211` | `REFUSAL_LABELS` 加 `kit-empty` / `kit-read-failed` |
| 工具 | **新** `.pi/extensions/kit-source.ts` | `kit_list_products`（第 4 节） |
| 工具 | `.pi/settings.json` | `extensions` 加 `extensions/kit-source.ts` |
| 词表 | **新** `lib/kit/categories.ts`、`lib/kit/attributes.ts` | 品类与属性 SSOT，零 `@/` 依赖（第 7 节） |
| 预设 | **新** `lib/kit/preset.ts`、`lib/kit/preset-data.ts` | 播种 + `kit-state.json`；内容见第 5.2 节 |
| 判断 | **新** `lib/kit/judge.ts` | `parsePurchaseText` / `judgeAttributes`，单次模型调用（第 6.5 节） |
| 导入 | **新** `app/api/user-products/import/route.ts`、`…/import/commit/route.ts` | 解析（不写库）/ 确认写库 |
| 判断 | **新** `app/api/user-products/[id]/judge/route.ts` | 手动录入后的自动判断与「重新判断特点」（第 6.3 节） |
| 存储 | `lib/storage/user-products.ts:1` | `@/lib/storage/json-store` → `./json-store`（第 4.4 节） |
| 存储 | `lib/storage/user-products.ts:6-19,26-49,51-70` | 新增字段的读写；`ProductInput` 放宽必填 |
| 类型 | `lib/types/domain.ts:1-20` | `UserProduct` 加 `recordSource` / `attributeSources`（可选，旧数据兼容） |
| API | `app/api/user-products/route.ts:17-19` | 必填从 brand/name/category 收敛为 **category/brand**；接入 `ensurePresetSeeded` |
| API | `app/api/user-products/[id]/route.ts:11-25` | 编辑时按第 6.6 节把改动的属性来源转 `"user"` |
| 前端 | `frontend/lib/constants.ts:10` | `IS_LIBRARY_OPEN → true` |
| 前端 | `frontend/lib/constants.ts:13-26` | `CATEGORY_OPTIONS` 从 `lib/kit/categories.ts` 派生 |
| 前端 | `frontend/hooks/useBeautyKit.ts:57` | 必填校验放宽；接入导入与判断 |
| 前端 | `frontend/components/beauty-kit/ProductDialog.tsx:79-176` | 产品名等改选填；特点区按第 7.2 节维度渲染，每项可一键修正（第 6.6 节） |
| 前端 | `frontend/components/beauty-kit/LibraryView.tsx` | preset 条目标记；特点展示与来源提示；空态文案区分「未记录」与「筛选无结果」（后者已有） |
| 前端 | **新** `frontend/components/beauty-kit/ImportDialog.tsx`、`PresetNotice.tsx` | 第 5.3 / 6.4 节 |
| 前端 | **删** `frontend/components/beauty-kit/LibraryComingSoon.tsx` | 门开了，不应再留第二道门的假象 |
| 配置 | `.env.example` | 加 `KIT_PRESET_ENABLED`、`KIT_IMPORT_MAX_CHARS`、`KIT_IMPORT_TIMEOUT_SECONDS`；更新 `PI_SKILL_PATH` 注释 |
| 部署 | `scripts/preflight.mjs` | 校验两个技能目录 |
| 文档 | `AGENTS.md` | 补 `lib/kit/`、`makeup-kit/` 的定位 |
| 测试 | **新** `test/L1/kit-*.test.ts` | 第 10.1 节 |

## 10. 测试与验收

### 10.1 L1（`npm run test:l1`，不发网络）

妆匣相关今天零覆盖，全部新建。

| 用例 | 断言 |
| --- | --- |
| 品类归一化 | 12 个 `categoryId` 双向映射；别名（「口红」「唇釉」「唇妆（口红）」→ `lip`）；未知品类保留不丢弃；`CATEGORY_OPTIONS` 派生后顺序与内容不变 |
| 属性词表 | 逐品类维度与闭集取值齐全；闭集外的取值进 `effectTags` 且**不参与**妆效比对 |
| `intensity` 派生 | `base` 遮盖力高＋雾面 → 浓郁；遮盖力清透 → 清透；**维度改了重算派生值，不改维度** |
| 工具契约 | `availability` 三态各返回正确形状；`empty` 与 `read-failed` **不混淆**；`categoryId` 过滤；`bad-argument` 拒绝；**返回体里没有 `userId` 参数入口** |
| 逐属性来源 | 判断后各属性均为 `model-inferred`；用户只改 `colorFamily` → **仅该键**转 `user`，其余不动 |
| 手动录入降级 | 判断调用失败/超时 → 记录仍在、特点留空、不阻断保存；「重新判断特点」可补 |
| 预设播种 | 空库播种（`status: "owned"`、`recordSource: "preset"`、属性 `search-verified`）；再读不重播；**用户清空后不重播**；`KIT_PRESET_ENABLED=false` 不播种；库非空时不播种 |
| 导入解析 | 固定文本 fixture → 预期 items + 特点；非化妆品进 `skipped`；色号缺失进 `unknowns` 且**不编造**；输出是合法 JSON |
| 导入落库 | 预览阶段**零写入**（断言存储未变）；确认后写入；选「已用完」写 `"retired"` 且不再出现在 `listUserProducts` |
| **技能契约守卫** | `SKILL.md` 含 `looktrace-products` 与 `looktrace.products.v1`；`happy-path.md` 含商品块与五字段说明；技能文本里**不出现** `node ` + `scripts/` |
| 既有回归 | `test/L1/product-block.test.ts`、`taobao-cards.test.ts` 继续全绿 |

两条是核心回归，少了它们整套设计会静默退化：「**用户清空后不重播**」（少了它删除会「失效」）与「**只该键转 `user`**」（少了它一处手改会把整条记录标成用户确认，第 6.6 节的区分就没了）。

### 10.2 验收清单

1. `npm run typecheck` 与 `npm run test:l1` 通过。
2. 空库新用户打开妆匣 Tab：看到预设条目 + 「示例妆匣」提示条，每条带特点。
3. 对话里问一个风格：工具调用里**出现** `kit_list_products`，结论对预置单品标 `✅`，并且**说得出是哪件、为什么能满足**（第 7.2 节的维度对得上，而不是「同属口红」）。
4. 清空示例后再问：模型明确说「妆匣未记录」，**不说**「你没有」。
5. 关掉 `KIT_PRESET_ENABLED` 且清空妆匣：模型说本轮没取得妆匣数据，购买判断保留为条件候选。
6. 手动加一件只填品类/品牌：保存立刻成功，随后特点自动填上；把「浓淡」一键改成「淡妆」后，对话里模型按修正后的值判断。
7. 粘贴一段真实淘宝订单文字：预览出可编辑条目（含特点），确认后进妆匣；`skipped` 可见。
8. **商品卡片照旧出现在答案末尾**（技能升级没碰坏 `looktrace-products`）。
9. `DEPLOY_DRY_RUN=1 ./scripts/deploy.sh` 通过。

### 10.3 L3（`RUN_L3_E2E=1`，会真调模型）

在 `test/L3/pi-skill.e2e.test.ts` 的既有形状上加一条：断言 `<available_skills>` 里**两个技能都在**，且模型能按 `kit_list_products` 的返回做出一致的 `✅`/`💰` 判断。

## 11. 安全

1. **妆匣内容进模型上下文**：属于产品信息，非身份信息。技能已要求检索时「只发产品信息，不发用户身份或完整妆匣」（`makeup-kit/SKILL.md:28`），第 8.2 节的合并里**保留**这条。
2. **模型不能切换用户**：工具无 `userId` 参数，身份只来自运行时注入（第 4.1 节）。
3. **粘贴文本是 prompt injection 面**：判断 prompt 明确把它当**数据**，忽略其中任何指令；落库只取结构化字段，**原文不进 Agent 上下文**（只回显在预览界面给用户看）。
4. **粘贴文本不进日志**：沿用 `LANGFUSE_TRACE_INCLUDE_CONTENT` 的既有约定，判断链路不记正文。
5. **`read` 工具无沙箱**（既有问题，`lib/pi/events.ts:304-306`）：本文不改，但把妆匣读取**引导到工具**，并在提示词里禁止用 `read` 读数据目录。妆匣落进数据目录后，这个洞的后果从「能读到 `.env`」扩到「能读到用户数据」，值得单独立项（第 12.7 节）。
6. **`userId` 由请求体信任**（既有）：单用户阶段不变。`kit_list_products` 从环境变量取身份、**不接受模型或请求体传入**，为将来接鉴权留好形状。

## 12. 未确认

1. **预设套件的具体选品**：需逐条核实真实品牌/产品线/色号与特点（第 5.2 节）。核实完成前 `KIT_PRESET_ENABLED` 保持关闭。
2. **`base` 品类放什么**：第 5.2 节排除粉底色号，但 `base` 本身要不要放、放妆前乳是否合适，需要产品判断。
3. **决策 6（不回写）的代价还没有量。** 同一件产品每轮都要重新检索核实：计费重复，且**跨轮结论仍可能不一致**——录入时的 `model-inferred` 特点只是线索，不是保证。要观察的是「一轮里有多少件已有品被重新核实」；占比高就该重新评估这条（可选做法：由**应用**而非 Agent 记录本轮核实结果，Agent 仍不写用户数据）。**在那之前不要把 `model-inferred` 说成已核实。**
4. **属性词表的取值够不够用**：第 7.2 节那份是照常见品类推的，没有真实匹配数据支撑。需要几轮真实推荐才知道缺哪些维度、哪些闭集取值永远用不上，以及 `intensity` 的派生规则在多少件上会判错。
5. **`user-products.json` 的读-改-写竞争**：`readJson` 解析失败会静默返回 fallback，而这是「读-改-写」（[09-26-cicd-deploy.md](./09-26-cicd-deploy.md) 第 7 节记过这个 bug）。录入把写入者从 1 个变成多个（手动/导入/播种/判断回填），**放大**既有风险。是否加进程内串行化（`conversation-lock.ts` 有同款形状可参考）待评估。
6. **判断调用的实际形态与开销**：`--mode json` 下怎么取最终文本、`--no-session` + `--no-builtin-tools` 是否干净，都待实测。手动路径每加一件一次调用，导入路径一批一次。若实测偏慢或输出难取，退路是直连供应商端点（代价：多一套 baseURL/密钥映射）。
7. **分用户**：现在全是 `local-user`。工具的身份来源已按「应用提供」设计，真多用户需要鉴权，不在本期。
8. **`read` 的沙箱**：既有问题，本文不改（第 11.5 节）。

## 附录 A：已否决的路线

### A.1 不引入上游的两个取数脚本（2026-10-16 否决）

`tikhub-xhs-video-reader/scripts/xhs_video_evidence.mjs` 与 `xiaohongshu-makeup-advisor/scripts/xhs_image_evidence.mjs` 打的是**同一批上游**：`api.tikhub.io` + `XHS_API_TOKEN`，路径就是 `search_notes` / `get_image_note_detail` / `get_video_note_detail`。

收进来的代价：

- **同一上游两套实现**，字段与错误码会各自漂移（SSOT 的意义就没了）。
- 绕过 `XHS_API_BUDGET_SECONDS` / `XHS_API_DETAIL_LIMIT` / `XHS_API_SEARCH_PAGES` 三个闸门——而详情是**计费调用**。
- 技能里出现 `node <path>` 就等于把传输方式焊进技能，违反 [09-17 第 5 节](./09-17-pi-skill-runtime.md) 的「约束跟着工具走」。

**遗留情报（不要重新踩）**：上游脚本按 `TIKHUB_API_KEY` → `XHS_API_TOKEN` → 当前目录 `.env` 的顺序取凭据，我们的取数只认 `XHS_API_TOKEN`；两边对「一次搜索 + N 条详情」的计费口径一致，但脚本没有我们的预算闸门，所以**不要为了「试试看」单独跑一次**——它不受 `.env` 里的预算变量约束。

### A.2 不做截图 / OCR / 视觉（2026-10-16 否决）

淘宝订单页截图是最省事的输入，但要新增视觉能力：`PI_MODEL=deepseek-chat` 无视觉（[09-25 附录 A.2](./09-25-video-understanding.md) 实测 pi 的 deepseek 目录里唯一声明视觉的是 `deepseek-v4-flash-vision-exp`），且引入 OCR 或视觉模型违反「取数不需要任何二进制」。**产品后果**是明确的：用户需要复制文字，不能直接贴图。要重提这条，先读 09-25 附录 A.1 的成本对照。

### A.3 不复活 `OwnedProductMatch`（2026-10-16 否决）

[001-mvp.md:735-737](./001-mvp.md) 规划过服务端匹配函数，`OwnedProductMatch` 是它的类型遗留。本次**不实现**：匹配规则与技能文本同源、可随技能迭代，做成服务端代码就等于把规则写到两处并各自漂移。死类型也不删——清理应作为独立改动，不混进妆匣的提交。

### A.4 [001-mvp.md](./001-mvp.md) 的「不做粘贴清单结构化」为何被推翻

原文（`:154`、`:480`、`:961`）：「一期只支持手动输入，**不做图片识别录入或粘贴清单自动结构化**」。

当时的约束是**没有可靠的解析手段**——结构化要么靠人工填表，要么靠脆弱的正则。第 6.4 节把它改成「模型解析 + **人工逐条确认** + 未知留空」，解析质量不再是唯一防线。**「图片识别录入」仍然不做**（决策 2 与附录 A.2）。其余原始条款（`:21` 妆匣是手段不是目标、`:152-154` 不要求先建档）继续沿用。

### A.5 不在录入时做检索核实（2026-10-16 否决）

「录入时就查真实试色与官方属性」听起来比模型推断可靠，但代价结构不对：

- **检索能力只存在于 pi 扩展工具里**（`.pi/extensions/xhs-source.ts`）。录入路径要用它，要么让判断调用带上 `xhs_*` 工具（一次 JSON 抽取变成 agentic 循环），要么让服务端直接调 `lib/xhs/tikhub.ts` ——**绕过扩展里的 `XHS_API_DETAIL_LIMIT` 与预算闸门**，或者把闸门抽出来给两处共用（额外重构）。
- **无界计费**：详情按次计费，每件至少一次。导入 12 件就是十几次调用，而录入是与用户对话无关的后台动作，**没有任何预算闸门管它**。
- 它要解决的问题（属性可信度）已经由第 6.6 节的逐属性来源表达了：判断结果是 `model-inferred`，Agent 在**真正需要判断复用**时按技能做一次检索核实。花钱的时机从「录入时一律查」挪到「决策时按需查」。

**遗留情报**：`lib/xhs/tikhub.ts` 是可被服务端直接 import 的普通模块（扩展就是用相对路径 import 它的），所以「服务端直接检索」在技术上一直可行——门槛不是能不能，而是**闸门归谁**。要做这条，先把预算与详情上限从扩展里抽成共用模块，否则就是同一上游两套纪律。

## 13. 实施记录（2026-10-16）

实现落在分支 `feat/makeup-kit`，分五个提交：词表与存储 → 只读读路径 + `makeup-kit` 技能 → advisor 三方合并 + 契约守卫 → 预设与开门 → 判断与导入。第 9 节的改动清单已按实际实现更新。

### 实现期间发现的四处需要偏离原稿的地方

1. **`readJson` 分不出「空」与「坏」。** 它对**任何**失败都返回 fallback，所以一个被截断的 `user-products.json` 会读成 `[]`——「读不到」于是伪装成「妆匣是空的」，正好是第 4.2 节最要防的那件事。新增 `readJsonChecked`（区分 `missing` / `corrupt`），**只有妆匣这条路径用它**，`readJson` 的语义一个字没改，存量调用方零影响。

2. **`empty` 的判定比原稿宽。** 原文说 `empty` 是「成功读取，但这个用户的妆匣是空的」。实现时发现还有一种同义情况：文件在、但按 `userId` 过滤后没有可用记录（全是别人的、或全是 `retired`）。对模型来说这与「空妆匣」是同一句话，所以 `loadKitProducts` 一并归到 `empty`；`ok` + 0 条只出现在**带 `categoryId` 过滤**时（`reason: kit-no-category`）。

3. **`colorFamily` 是开放维度。** 第 7.2 节原文写「取值是闭集」，实现时按技能自己的判例（`matching-cases.md` 的「烈焰红唇 vs 橘色嘴唇」）改成**推荐词表 + 语义比对**：色系的合法取值本质开放，硬套闭集只会把真话挤成错话。其余维度仍是严格闭集，`AttributeSpec.strict` 区分两者。

4. **多了一个 `KIT_LIST_LIMIT`（默认 60）。** 原稿没写返回条数上限，但把整个妆匣塞进上下文是无界的，超限时截断并在 payload 里如实说明（`truncated: true` + 「传 categoryId 缩小范围」）。

5. **逐属性来源不能照单全收。** 第 6.6 节原本没写清「编辑时哪些键转 `user`」。实现后真机一测就露了：表单保存会把**所有**字段一起提交（用户看到的是填好的旧值），于是改一个色系就把三个属性全标成 `user`，「模型推断的线索」与「用户的声明」当场没了区别。新增 `sourcesAfterEdit`（值变了才转 `user`，没变保留原来源，清空的键连来源一起去掉），放在 `lib/kit/attributes.ts` 里以便测试。

6. **`GET /api/user-products` 也要用严格读。** 原稿只要求**工具**区分 `empty` 与 `read-failed`。但同一个坏文件下，界面会显示「库还是空的」，用户接着录一件，写入就把坏文件覆盖成只剩这一件——`readJson` 的宽容语义把这件事变成静默的数据丢失。所以 GET 改用与工具同一个 `loadKitProducts`：坏文件返回 500 + 明确原因，界面弹「读取妆匣失败」而不是假装空库。健康路径行为不变（空库仍是 200 + `[]`）。

另外两处命名/结构上的落地选择：来源字段在存储里叫 `attributeSources`、记录来源叫 `recordSource`（避免与工具返回体顶层的 `source` 撞名）；`IS_LIBRARY_OPEN` 与 `LibraryComingSoon` **连开关一起删了**，而不是按原稿说的「改成 true」——理由见下。

### 为什么删掉 `IS_LIBRARY_OPEN` 而不是打开它

原稿（决策 4）只说要打开。实现时判断留着这个开关会更坏：它只藏界面、**不挡 Agent 读库**，所以关掉之后页面显示「暂未开放」而顾问照样在用用户没录入过的数据——比开门和比真关门都差。要再关，得同时决定 Agent 侧怎么办，那是新决定，不是翻这个开关。`frontend/lib/constants.ts` 留了注释记这件事。

### 第三处必须保住的契约：不给可点链接

第 8.2 节的「拒绝」表原本列了四条，实现三方合并时发现还有一条：上游新版把来源标注从「站内复搜关键词（本轮不给可点链接）」改成了「附笔记链接」。仓库这边验证过拼出来的 `https://www.xiaohongshu.com/explore/<id>` **打不开**，而且我们的工具返回里根本没有可用的笔记链接，所以这条按仓库版本保留，并加进了 `test/L1/skill-contracts.test.ts`。

### 验证结果

| 验收项（第 10.2 节） | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ |
| `npm run test:l1` | ✅ 189 通过，其中妆匣相关新增 **56** 条：词汇 8（`kit-vocabulary`）、存储 11（`kit-storage`）、工具 9（`kit-source-extension`）、预设 9（`kit-preset`）、导入 11（`kit-import`）、技能契约 8（`skill-contracts`）；原有用例全绿 |
| `npm run build` | ✅ 路由含 `/api/user-products/preset`、`/import`、`/import/commit`、`/[id]/judge` |
| 起真实服务跑接口（`next start` + 临时 `LOOKTRACE_DATA_DIR`） | ✅ 空库 GET 200 / `[]`；只填品牌+品类 POST 201（原先必填产品名）；导入提交 201 且 `retired` 条目不进列表；清空示例 `removed: 0` 不动自有条目；PATCH 改一个属性**只有该键**转 `user`；坏文件 GET 500 + 原因；缺品牌 400 |
| `DEPLOY_DRY_RUN=1 ./scripts/deploy.sh` | ✅ 两个技能都在，两个扩展都加载成功（`errors=0`），妆匣工具返回 `availability=empty` |
| 扩展能通过 pi 的 **jiti** 加载器 | ✅ 真加载器实测（node 的解析器不等于 jiti，这一步是本轮唯一不能靠 L1 覆盖的接线） |
| 技能契约守卫 | ✅ 商品块 / 色号待试 / 不给链接 / 无 `node scripts/` / 相对引用都存在 |

### 仍未验证

- **真起 pi 进程的两条链路**：`kit_list_products` 在一次真实对话里被调用（L3），以及 `lib/kit/judge.ts` 的单发调用真的能取回可用 JSON（`--mode json` 下 `message_end` 的取法与 `--no-session` 的干净程度）。本轮按约定不做 L3，两条都只覆盖到调用前后的纯逻辑与落库路径。**第 12.6 节因此仍未关闭。**
- **预设套件的内容**：`lib/kit/preset-data.ts` 是空的，`KIT_PRESET_ENABLED` 默认 `false`。播种机制、幂等、清空不重播都有测试（用夹具注入），但真实选品一条都还没核实——决策 1 的用户可见效果因此**尚未上线**。
- **`base` 品类放什么**（第 12.2 节）与**属性词表的取值够不够用**（第 12.4 节）：都要等真实推荐跑几轮才知道。
- **决策 6（不回写）的代价**（第 12.3 节）：现在能看清的是「同一件产品每轮都要重新核实」，但占比没有数据。

### 死代码清理仍不在本次范围

`OwnedProductMatch` / `AgentAnswer` / `SearchPlan` / `SkuCandidate` / `ToolRun` / `LookFeatureSet` / `EvidenceItem` / `SourceItem` 都没有消费者，本次没删也没复活（附录 A.3）。
