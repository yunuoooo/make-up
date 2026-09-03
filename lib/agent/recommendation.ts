import type {
  EvidenceItem,
  LookFeatureSet,
  OwnedProductMatch,
  ProductCapability,
  SkuCandidate,
  SourceItem,
  UserProduct
} from "@/lib/types/domain";

const categorySkuSeeds: Record<string, Array<Omit<SkuCandidate, "id" | "rank" | "priority" | "reason" | "offerStatus">>> = {
  "粉底液": [
    {
      brand: "花西子",
      name: "玉养柔焦粉底液",
      skuId: "huaxizi-foundation-softfocus-01",
      category: "粉底液",
      shade: "适合自然偏白肤色",
      colorFamily: "自然色",
      finish: "柔焦半哑光",
      texture: "轻薄液体",
      effectTags: ["薄透底妆", "柔焦", "低存在感"],
      evidenceSummary: "适合低饱和、干净边界的底妆目标。",
      capabilityTags: ["薄透", "柔焦", "持妆"]
    },
    {
      brand: "完美日记",
      name: "轻透持妆粉底液",
      skuId: "perfect-diary-foundation-lightwear",
      category: "粉底液",
      shade: "自然色",
      colorFamily: "自然色",
      finish: "半哑光",
      texture: "流动液体",
      effectTags: ["轻薄", "通勤", "均匀肤色"],
      evidenceSummary: "适合不强调强遮瑕的文字妆容目标。",
      capabilityTags: ["轻薄", "通勤", "均匀"]
    }
  ],
  "腮红": [
    {
      brand: "橘朵",
      name: "单色腮红",
      skuId: "judydoll-blush-nude-pink",
      category: "腮红",
      shade: "奶杏裸粉",
      colorFamily: "杏粉",
      finish: "哑光",
      texture: "粉状",
      effectTags: ["低饱和", "自然气色", "边界柔和"],
      evidenceSummary: "可承接白开水妆、通勤妆里的弱腮红需求。",
      capabilityTags: ["低饱和", "裸粉", "哑光"]
    },
    {
      brand: "into you",
      name: "柔雾腮红",
      skuId: "intoyou-blush-cool-pink",
      category: "腮红",
      shade: "冷粉",
      colorFamily: "冷粉",
      finish: "雾面",
      texture: "粉霜",
      effectTags: ["冷感", "清冷", "柔雾"],
      evidenceSummary: "适合清冷感、灰调妆容的腮红重心。",
      capabilityTags: ["冷粉", "雾面", "清冷"]
    }
  ],
  "眉笔": [
    {
      brand: "卡奇色彩",
      name: "极细眉笔",
      skuId: "katos-brow-pencil-ash-brown",
      category: "眉笔",
      shade: "灰棕",
      colorFamily: "灰棕",
      finish: "自然",
      texture: "硬芯",
      effectTags: ["灰棕眉眼", "细线条", "低存在感"],
      evidenceSummary: "适合不抢妆面的低饱和眉眼。",
      capabilityTags: ["灰棕", "细线条", "自然"]
    }
  ],
  "唇泥": [
    {
      brand: "into you",
      name: "女主角唇泥",
      skuId: "intoyou-lip-mud-dousha",
      category: "唇泥",
      shade: "低饱和豆沙",
      colorFamily: "豆沙",
      finish: "柔雾",
      texture: "泥状",
      effectTags: ["豆沙唇", "雾面", "低饱和"],
      evidenceSummary: "适合白开水妆里低存在感但完整的唇部。",
      capabilityTags: ["豆沙", "柔雾", "低饱和"]
    }
  ],
  "唇釉": [
    {
      brand: "珂拉琪",
      name: "空气唇釉",
      skuId: "colorkey-lip-glaze-muted-rose",
      category: "唇釉",
      shade: "灰粉玫瑰",
      colorFamily: "玫瑰",
      finish: "柔雾",
      texture: "唇釉",
      effectTags: ["低饱和", "灰粉", "通勤"],
      evidenceSummary: "适合低饱和、清冷或通勤妆效。",
      capabilityTags: ["灰粉", "柔雾", "通勤"]
    }
  ],
  "修容": [
    {
      brand: "too cool for school",
      name: "三色修容盘",
      skuId: "tcfs-contour-ash-brown",
      category: "修容",
      shade: "灰棕",
      colorFamily: "灰棕",
      finish: "哑光",
      texture: "粉状",
      effectTags: ["骨相", "清冷", "灰调"],
      evidenceSummary: "适合清冷骨相妆里的轮廓收紧。",
      capabilityTags: ["灰棕", "骨相", "哑光"]
    }
  ],
  "眼影": [
    {
      brand: "3CE",
      name: "九宫格眼影盘",
      skuId: "3ce-eye-palette-muted-brown",
      category: "眼影",
      shade: "低饱和大地色",
      colorFamily: "棕色",
      finish: "哑光",
      texture: "粉状",
      effectTags: ["低彩度", "自然眼妆", "雾面"],
      evidenceSummary: "适合弱化眼妆存在感，同时保留眼部层次。",
      capabilityTags: ["低饱和", "大地色", "哑光"]
    }
  ],
  "卧蚕笔": [
    {
      brand: "橘朵",
      name: "卧蚕提亮笔",
      skuId: "judydoll-aegyosal-pencil-soft-beige",
      category: "卧蚕笔",
      shade: "米杏",
      colorFamily: "米杏",
      finish: "微光",
      texture: "膏状",
      effectTags: ["卧蚕提亮", "氛围感", "柔和"],
      evidenceSummary: "适合粉调氛围妆的轻微眼下提亮。",
      capabilityTags: ["提亮", "卧蚕", "氛围"]
    }
  ]
};

const categoryReasons: Record<string, string> = {
  "粉底液": "底妆决定妆面的干净程度和质地，是目标妆效的底层画布。",
  "腮红": "腮红控制气色和面部重心，低饱和妆尤其依赖色系和边界。",
  "眉笔": "眉色会影响妆面的清冷或柔和程度，灰棕更容易压低存在感。",
  "唇泥": "柔雾唇部能维持低饱和妆的完整度，同时不抢眼。",
  "唇釉": "唇釉决定唇部色调和质地，是风格落点最明显的 SKU。",
  "修容": "修容负责骨相和轮廓，清冷感通常依赖灰棕而不是暖棕。",
  "眼影": "眼影负责眼部层次，低饱和目标需要控制珠光和显色度。",
  "卧蚕笔": "卧蚕笔增强氛围感，但应控制亮度，避免破坏低饱和。"
};

export function decomposeLook(message: string, sources: SourceItem[], evidence: EvidenceItem[]): LookFeatureSet {
  const allFeatures = Array.from(new Set(evidence.flatMap((item) => item.lookFeatures)));
  const allCategories = Array.from(new Set(evidence.flatMap((item) => item.categoryPatterns)));
  const normalized = message.toLowerCase();
  const hasCoolTone = /清冷|冷|灰|骨相/.test(normalized);
  const hasMist = /雾|哑光|低饱和|高级|通勤/.test(normalized);

  const neededCapabilities: ProductCapability[] = allCategories.map((category, index) => ({
    category,
    capability: categoryReasons[category] ?? `${category}需要和目标妆效的色系、质地一致。`,
    reason: categoryReasons[category] ?? `小红书搜索结果反复提到${category}。`,
    priority: index < 2 ? "necessary" : index < 4 ? "helpful" : "optional",
    tags: allFeatures.slice(0, 5)
  }));

  return {
    overallStyle: sources[0]?.title.replace(/：.*/, "") || "文字妆容目标",
    base: hasMist ? ["柔焦或半哑光", "薄透", "边界干净"] : ["轻薄", "均匀肤色"],
    eyes: hasCoolTone ? ["灰棕眉眼", "低彩度眼影", "轮廓收紧"] : ["自然层次", "弱珠光"],
    brows: hasCoolTone ? ["灰棕", "线条细"] : ["自然棕", "低存在感"],
    cheeks: allFeatures.includes("冷粉腮红") ? ["冷粉", "低饱和", "边界柔"] : ["奶杏或裸粉", "低饱和"],
    lips: allFeatures.includes("豆沙唇") ? ["豆沙", "柔雾"] : ["低饱和", "和腮红同色系"],
    colors: allFeatures.filter((feature) => /粉|灰|棕|杏|豆沙|低饱和|冷/.test(feature)).slice(0, 6),
    texture: hasMist ? ["雾面", "柔焦", "弱光泽"] : ["轻薄", "自然"],
    focus: hasCoolTone ? ["轮廓", "眉眼色调"] : ["干净底妆", "腮红和唇部同色系"],
    neededCapabilities,
    difficulty: ["不要照搬单个博主清单，要看品类能力是否匹配", "SKU 的色号和质地比品牌名更关键"],
    uncertainty: ["当前是文字版 MVP，无法直接从图片判断真实光线和肤色", "小红书内容可能带种草属性，推荐需要看共同点"]
  };
}

export function recommendSkuCandidates(look: LookFeatureSet, evidence: EvidenceItem[]): SkuCandidate[] {
  const mentionedCategories = Array.from(new Set([
    ...look.neededCapabilities.map((capability) => capability.category),
    ...evidence.flatMap((item) => item.categoryPatterns)
  ]));

  return mentionedCategories
    .flatMap((category) => {
      const capability = look.neededCapabilities.find((item) => item.category === category);
      return (categorySkuSeeds[category] ?? []).slice(0, 2).map((seed) => ({
        ...seed,
        id: `${seed.skuId}-${Math.random().toString(36).slice(2, 6)}`,
        rank: 0,
        priority: capability?.priority ?? "helpful",
        reason: capability?.reason ?? seed.evidenceSummary,
        offerStatus: "placeholder" as const
      }));
    })
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1
    }))
    .slice(0, 8);
}

export function matchOwnedProducts(products: UserProduct[], look: LookFeatureSet): OwnedProductMatch {
  if (products.length === 0) {
    return {
      reviewed: false,
      usableItems: [],
      partialMatches: [],
      notSuitable: [],
      missingCapabilities: look.neededCapabilities,
      riskNotes: ["还没有妆匣产品，所以本轮直接按目标妆效推荐 SKU。"]
    };
  }

  const usableItems: UserProduct[] = [];
  const partialMatches: UserProduct[] = [];
  const notSuitable: UserProduct[] = [];

  for (const product of products) {
    const productText = [
      product.category,
      product.colorFamily,
      product.finish,
      product.texture,
      product.shade,
      ...product.effectTags
    ].filter(Boolean).join(" ");

    const categoryHit = look.neededCapabilities.some((capability) => capability.category === product.category);
    const tagHit = look.neededCapabilities.some((capability) =>
      capability.tags.some((tag) => productText.includes(tag)) || productText.includes(capability.category)
    );

    if (categoryHit && tagHit) {
      usableItems.push(product);
    } else if (categoryHit) {
      partialMatches.push(product);
    } else {
      notSuitable.push(product);
    }
  }

  const coveredCategories = new Set([...usableItems, ...partialMatches].map((product) => product.category));
  const missingCapabilities = look.neededCapabilities.filter((capability) => !coveredCategories.has(capability.category));

  return {
    reviewed: true,
    usableItems,
    partialMatches,
    notSuitable,
    missingCapabilities,
    riskNotes: missingCapabilities.length > 0
      ? [`我看了你的妆匣，现有产品还缺 ${missingCapabilities.map((item) => item.category).join("、")} 这些能力。`]
      : ["你的妆匣已经覆盖主要品类，优先用已有产品即可。"]
  };
}
