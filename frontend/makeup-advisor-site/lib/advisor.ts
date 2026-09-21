import type {
  AdvisorReply,
  Product,
  RecommendationProduct,
  RecommendationRow,
} from "@/lib/makeup-types";

type ProductSpec = {
  category: string;
  tokens: string[];
  candidate: {
    label: string;
    image: string;
    query: string;
  };
};

function taobaoSearchUrl(query: string) {
  return `https://s.taobao.com/search?q=${encodeURIComponent(query)}`;
}

function productText(product: Product) {
  return [
    product.brand,
    product.name,
    product.category,
    product.shade,
    product.finish,
    product.tags,
    product.notes,
  ]
    .join(" ")
    .toLowerCase();
}

function resolveProduct(
  products: Product[],
  spec: ProductSpec,
): RecommendationProduct {
  const owned = products.find((product) => {
    if (product.category !== spec.category) return false;
    const text = productText(product);
    return spec.tokens.some((token) => text.includes(token.toLowerCase()));
  });

  if (owned) {
    const label = `${owned.brand}｜${owned.name}｜${owned.shade}`;
    return {
      status: "owned",
      label,
      evidence: "个人妆品库匹配",
      image: spec.candidate.image,
      imageAlt: `${owned.brand} ${owned.name} 同类商品参考图`,
      taobaoUrl: taobaoSearchUrl(label.replaceAll("｜", " ")),
    };
  }

  return {
    status: "buy",
    label: spec.candidate.label,
    evidence: "特征匹配·演示候选",
    image: spec.candidate.image,
    imageAlt: `${spec.candidate.label.replaceAll("｜", " ")} 商品图`,
    taobaoUrl: taobaoSearchUrl(spec.candidate.query),
  };
}

function row(
  products: Product[],
  values: Omit<RecommendationRow, "products"> & { specs: ProductSpec[] },
): RecommendationRow {
  const { specs, ...rest } = values;
  return {
    ...rest,
    products: specs.map((spec) => resolveProduct(products, spec)),
  };
}

function cleanStyleName(prompt: string) {
  const compact = prompt
    .replace(/[，。！？?!]/g, " ")
    .replace(/我想|想要|帮我|请|画一个|化一个|怎么画|怎么化/g, "")
    .trim();
  return compact.slice(0, 24) || "自然清透妆";
}

export function buildAdvisorReply(
  prompt: string,
  products: Product[],
): AdvisorReply {
  const styleName = cleanStyleName(prompt);
  const isCool = /清冷|骨相|灰调|冷调/.test(prompt);
  const isOxygen = /氧气|韩系|白开水|清透|裸妆/.test(prompt);

  const eyeCandidate = isCool
    ? {
        label: "rom&nd｜Better Than Palette｜#04 Dusty Fog Garden",
        image: "./products/romand-better-than-palette-04.webp",
        query: "romand Better Than Palette 04 Dusty Fog Garden",
      }
    : {
        label: "dasique｜Shadow Palette｜#07 Milk Latte",
        image: "./products/dasique-shadow-palette-07.png",
        query: "dasique Shadow Palette 07 Milk Latte",
      };
  const blushCandidate = isCool
    ? {
        label: "rom&nd｜Better Than Cheek｜#N02 Vine Nude",
        image: "./products/romand-better-than-cheek-n02.jpg",
        query: "romand Better Than Cheek N02 Vine Nude",
      }
    : {
        label: "rom&nd｜Better Than Cheek｜#C02 Blueberry Chip",
        image: "./products/romand-better-than-cheek-c02.jpg",
        query: "romand Better Than Cheek C02 Blueberry Chip",
      };
  const lipCandidate = isCool
    ? {
        label: "rom&nd｜Glasting Melting Balm｜#07 Mauve Whip",
        image: "./products/romand-glasting-melting-balm-07.jpg",
        query: "romand Glasting Melting Balm 07 Mauve Whip",
      }
    : {
        label: "rom&nd｜Glasting Melting Balm｜#03 Sorbet Balm",
        image: "./products/romand-glasting-melting-balm-03.jpg",
        query: "romand Glasting Melting Balm 03 Sorbet Balm",
      };

  const necessary: RecommendationRow[] = [
    row(products, {
      area: "全脸底妆",
      target: isOxygen ? "薄透、带自然光泽的奶油肌" : "干净均匀、保留真实皮肤纹理",
      method: "轻薄底妆 + 局部定妆",
      guidance: "薄薄一层拍开，只在容易出油处压粉；不要用高遮瑕把皮肤做成平面。",
      specs: [
        {
          category: "底妆",
          tokens: ["轻薄", "清透", "水润", "奶油", "自然光泽"],
          candidate: {
            label:
              "JUNG SAEM MOOL｜Essential Skin Nuder Cushion（水光版）｜色号待试：按颈部同色选择",
            image: "./products/jsm-essential-skin-nuder-cushion.jpg",
            query: "JUNG SAEM MOOL Essential Skin Nuder Cushion 水光版",
          },
        },
      ],
    }),
    row(products, {
      area: "眉毛",
      target: "低存在感的自然灰棕眉",
      method: "极细眉笔",
      guidance: "先补眉尾与空隙，眉头只顺着毛流带过，不画实心边框。",
      specs: [
        {
          category: "眉笔",
          tokens: ["灰棕", "自然棕", "细芯", "毛流"],
          candidate: {
            label: "ETUDE｜Drawing Eye Brow New｜#04 Dark Gray",
            image: "./products/etude-drawing-eye-brow-04.jpg",
            query: "ETUDE Drawing Eye Brow New 04 Dark Gray",
          },
        },
      ],
    }),
    row(products, {
      area: "眼窝 / 眼影",
      target: isCool ? "低饱和灰棕层次，不显肿" : "米杏奶茶色薄薄铺开",
      method: "低显色哑光眼影盘",
      guidance: "最浅色大面积打底，中间色贴睫毛根部与下眼尾；珠光只点在眼中。",
      specs: [
        {
          category: "眼影",
          tokens: isCool
            ? ["灰棕", "低饱和", "冷调", "消肿"]
            : ["米杏", "奶茶", "浅棕", "低饱和"],
          candidate: eyeCandidate,
        },
      ],
    }),
    row(products, {
      area: "眼线 / 睫毛",
      target: "细、短、根根分明，保留眼神留白",
      method: "棕色内眼线 + 纤长睫毛膏",
      guidance: "眼线只填睫毛空隙，眼尾平拉 2–3 mm；睫毛重点夹翘，不追求浓密。",
      specs: [
        {
          category: "眼线",
          tokens: ["棕", "细", "自然"],
          candidate: {
            label: "CANMAKE｜Creamy Touch Liner｜#02 Medium Brown",
            image: "./products/canmake-creamy-touch-liner-02.jpg",
            query: "CANMAKE Creamy Touch Liner 02 Medium Brown",
          },
        },
        {
          category: "睫毛膏",
          tokens: ["纤长", "根根分明", "棕", "自然"],
          candidate: {
            label: "ETUDE｜Curl Fix Mascara｜#02 Brown",
            image: "./products/etude-curl-fix-mascara-02.png",
            query: "ETUDE Curl Fix Mascara 02 Brown",
          },
        },
      ],
    }),
    row(products, {
      area: "中庭 / 面颊",
      target: isCool ? "冷粉气色，边界像皮肤透出来" : "淡粉气色，轻轻横向扩散",
      method: "低饱和粉状腮红",
      guidance: "从瞳孔外侧向耳前少量叠加，余粉扫过鼻梁；不要画出清楚圆形边界。",
      specs: [
        {
          category: "腮红",
          tokens: isCool
            ? ["冷粉", "低饱和", "灰粉"]
            : ["淡粉", "桃粉", "低饱和", "蓝莓"],
          candidate: blushCandidate,
        },
      ],
    }),
    row(products, {
      area: "嘴唇",
      target: "柔和粉调、水润但不厚重",
      method: "薄涂润泽唇膏",
      guidance: "先模糊唇线，再从唇心向外薄涂；深唇先用少量底妆压低原生唇色。",
      specs: [
        {
          category: "唇妆",
          tokens: ["粉", "豆沙", "水光", "清透", "玫瑰"],
          candidate: lipCandidate,
        },
      ],
    }),
  ];

  const optional: RecommendationRow[] = [
    row(products, {
      area: "鼻部 / 颧骨",
      target: "只有转动时才看得到的细闪光泽",
      method: "细腻香槟高光",
      guidance: "少量点在鼻尖、鼻梁中段和颧骨最高点；毛孔明显时跳过面中高光。",
      specs: [
        {
          category: "高光",
          tokens: ["细闪", "香槟", "自然", "水光"],
          candidate: {
            label: "CEZANNE｜Pearl Glow Highlight｜#01 Champagne Beige",
            image: "./products/cezanne-pearl-glow-highlight-01.jpg",
            query: "CEZANNE Pearl Glow Highlight 01 Champagne Beige",
          },
        },
      ],
    }),
    row(products, {
      area: "局部瑕疵",
      target: "保留轻薄底妆，同时遮住明显痘印或泛红",
      method: "点状遮瑕",
      guidance: "仅在需要处用小刷点涂，等待半干后拍开边缘；没有明显瑕疵可跳过。",
      specs: [
        {
          category: "遮瑕",
          tokens: ["局部", "轻薄", "自然"],
          candidate: {
            label:
              "the SAEM｜Cover Perfection Tip Concealer｜色号待试：按瑕疵处而非手背选色",
            image: "./products/the-saem-cover-perfection-tip-concealer.png",
            query: "the SAEM Cover Perfection Tip Concealer",
          },
        },
      ],
    }),
  ];

  return {
    styleName,
    summary: isOxygen
      ? "薄透奶油肌、淡粉气色和克制眉眼共同组成轻盈的韩系氧气感；重点是留白，不是把每一步都画满。"
      : "以干净底妆、协调色调和清晰但克制的视觉重心完成这套妆；先把妆效做准，再决定是否增加细节。",
    researchNotice:
      "当前网页演示版尚未连接小红书登录态；以下商品是依据妆效规格生成的特征匹配候选，不声称为博主同款。点击商品卡会打开淘宝搜索结果，购买前请复核店铺、在售版本与现场试色。",
    image: isOxygen ? "./oxygen-makeup.png" : undefined,
    necessary,
    optional,
    steps: [
      "先完成轻薄底妆，只给易出油位置定妆。",
      "按眉毛 → 眼影 → 眼线 → 睫毛的顺序做低存在感眉眼。",
      "腮红与唇色保持同一冷暖方向，先少后多。",
      "最后再判断高光与遮瑕是否真的需要。",
    ],
    followUp:
      "想让我把这版做得更贴你，可以继续告诉我肤质、肤色深浅与冷暖、预算、发色、是否接受假睫毛，以及偏清冷还是偏甜。化妆品库里已录入的完整单品，我会自动核对并改成 ✅。",
    sources: [
      "妆容拆解规则：视觉特征 → 产品规格 → 具体单品",
      "个人化妆品库：仅完整产品身份且规格匹配时标记 ✅",
      "产品证据标签：特征匹配·演示候选",
    ],
  };
}
