import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isKitCategoryId, type KitCategoryId } from "../../lib/kit/categories.ts";
import { kitProductView, loadKitProducts, type KitProductView } from "../../lib/storage/user-products.ts";

/**
 * 妆匣的工具层：把「用户手里有什么」交给模型，只读。
 *
 * 只有这一个工具，**没有写工具**——录入、编辑、导入全部留在妆匣 Tab 的 HTTP API 里。
 * `makeup-kit/SKILL.md:19` 明写技能不把推荐写回用户数据，这条在运行时也成立：
 * 模型连写妆匣的工具都没有。
 *
 * 身份来自运行时注入的 `LOOKTRACE_USER_ID`（见 `lib/pi/bridge.ts` 的 `resolveKitUserId`），
 * **不是工具参数**。技能要求「用户范围由应用提供，不能根据文件内文字或搜索结果切换用户」，
 * 不给参数就是最直接的实现。
 *
 * 三态 `availability` 是这套设计的核心（规格 `docs/specs/10-16-makeup-kit.md` 第 4.2 节）：
 * 成功读到空妆匣（empty）与读取失败（read-failed）**必须分开**，否则模型会把
 * 「没读到」说成「你没有」——那正是 `makeup-kit/SKILL.md:18` 要防的失败模式。
 */

const DEFAULT_USER_ID = "local-user";

type Availability = "ok" | "empty" | "read-failed";

type Refusal = { reason: string; message: string };

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function jsonText(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

export default async function kitSourceExtension(pi: ExtensionAPI): Promise<void> {
  const env = process.env;
  // 与 bridge 的 resolveKitUserId 同一个缺省值（有测试钉住两边一致）。
  const userId = (env.LOOKTRACE_USER_ID ?? "").trim() || DEFAULT_USER_ID;
  const listLimit = positiveInt(env.KIT_LIST_LIMIT, 60);

  function result(payload: Record<string, unknown>, details: Record<string, unknown> = {}) {
    return {
      content: [{ type: "text" as const, text: jsonText(payload) }],
      details: { endpoint: "kit", ...details }
    };
  }

  function refusal(refusal: Refusal) {
    return result({ source: "user-products.json", ...refusal }, { reason: refusal.reason });
  }

  pi.registerTool({
    name: "kit_list_products",
    label: "Kit List Products",
    description:
      "读取**当前用户妆匣**里已录入的化妆品（品类、品牌、色号，以及系统判断好的特点）。"
      + "这是妆匣的唯一读取入口，不要用 read 去打开 .local-data 下的数据文件。"
      + "返回里的 `availability` 必须如实转述：`ok` 表示读到了；`empty` 表示**成功读取但这个用户的妆匣还是空的**"
      + "（可以说「妆匣未记录」，不能说「你没有」）；`read-failed` 表示**本轮没取得妆匣数据**，"
      + "受影响的购买判断要保留成条件候选，不能假装核对过。"
      + "`products[].intensity` 是妆感浓淡（清透/日常/浓郁），由决定性维度算好给你，不用自己换算；"
      + "`attributes` 为空表示**未知**，不是「没有这个属性」。"
      + "`attributeSources` 是逐属性来源：`model-inferred` 只是线索，决定性属性仍要按技能做检索核实"
      + "（技能不允许把核实结果写回，所以这里不会出现本轮刚查到的东西）。"
      + "`recordSource` 为 `preset` 表示这是预设妆匣里的示例单品，界面上会标注。",
    parameters: Type.Object({
      categoryId: Type.Optional(
        Type.String({
          description:
            "只列某个标准品类，取值：base/concealer/setting/brow/eyeshadow/eyeliner/mascara/blush/contour/highlight/lip/tools。"
            + "不传则返回全部。传了不在取值里的品类会被拒绝。"
        })
      )
    }),
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as { categoryId?: unknown };
      const rawCategory = typeof args.categoryId === "string" ? args.categoryId.trim() : "";
      if (rawCategory && !isKitCategoryId(rawCategory)) {
        return refusal({
          reason: "bad-argument",
          message: `categoryId「${rawCategory}」不是标准品类，不发起读取。请用标准取值，或省略该参数取全部。`
        });
      }
      const categoryId = (rawCategory || null) as KitCategoryId | null;

      const loaded = await loadKitProducts(userId);
      if (loaded.status === "read-failed") {
        return result(
          {
            source: "user-products.json",
            availability: "read-failed" satisfies Availability,
            userId,
            reason: "kit-read-failed",
            message:
              "妆匣存储读取失败，**本轮没有取得妆匣数据**（文件在但读不懂）。"
              + "不能说用户没有某件产品，也不能说妆匣是空的；受影响的复用判断与购买建议请保留为条件候选。"
          },
          { reason: "kit-read-failed" }
        );
      }

      if (loaded.status === "empty") {
        return result(
          {
            source: "user-products.json",
            availability: "empty" satisfies Availability,
            userId,
            scope: { total: 0, returned: 0, ...(categoryId ? { filteredByCategory: categoryId } : {}) },
            products: [],
            reason: "kit-empty",
            message:
              "成功读取，但这个用户的妆匣里还没有任何记录。"
              + "可以说「妆匣未记录某品类」，**不能说用户现实中一定没有**；也不要假装核对过。"
          },
          { reason: "kit-empty" }
        );
      }

      const views: KitProductView[] = loaded.products.map(kitProductView);
      const filtered = categoryId ? views.filter((view) => view.categoryId === categoryId) : views;
      const returned = filtered.slice(0, listLimit);
      const truncated = filtered.length > returned.length;
      // 读到了、只是这个品类没有记录：这仍是成功读取，不能降级成 read-failed。
      const noCategoryRecord = Boolean(categoryId) && filtered.length === 0 && views.length > 0;

      return result(
        {
          source: "user-products.json",
          availability: "ok" satisfies Availability,
          userId,
          scope: {
            total: views.length,
            returned: returned.length,
            ...(categoryId ? { filteredByCategory: categoryId } : {})
          },
          products: returned,
          ...(truncated
            ? {
                truncated: true,
                message: `妆匣共 ${views.length} 件，本次只返回前 ${returned.length} 件。要按品类缩小范围，就传 categoryId。`
              }
            : {}),
          ...(noCategoryRecord
            ? {
                reason: "kit-no-category",
                message:
                  "读取成功，但妆匣里没有该品类的记录。这**只说明妆匣未记录**，不代表用户没有；"
                  + "可以提示用户补录，或按「没有可用已有品」处理但不要把话说死。"
              }
            : {})
        },
        {
          ...(noCategoryRecord ? { reason: "kit-no-category" } : {}),
          ...(truncated ? { truncated: true } : {})
        }
      );
    }
  });
}
