import type {
  CodingPlanCardCopyItem,
  CodingPlanProductPreviewPayment,
} from "@zcode/shared";

export function normalizeCodingPlanCardCopyItems(
  items: unknown,
): CodingPlanCardCopyItem[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.flatMap((item) => {
    if (
      typeof item !== "string" &&
      (!item || typeof item !== "object")
    ) {
      return [];
    }
    const text =
      typeof item === "string"
        ? item.trim()
        : typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text.trim()
          : "";
    if (!text) {
      return [];
    }
    const tooltip =
      typeof item === "string" ||
      typeof (item as { tooltip?: unknown }).tooltip !== "string"
        ? ""
        : (item as { tooltip: string }).tooltip.trim();
    return [{ text, ...(tooltip ? { tooltip } : {}) }];
  });
}

export type CodingPlanBillingPeriod = "monthly" | "quarterly" | "yearly";
export type CodingPlanPriceCurrency = "CNY" | "USD";
export type CodingPlanPriceUnit = "month" | "quarter" | "year";

export type CodingPlanProductDisplay = CodingPlanProductPreviewPayment & {
  priceCurrency?: CodingPlanPriceCurrency;
  externalPurchaseUrl?: string;
  hasPreview?: boolean;
  equity?: CodingPlanCardCopyItem[];
  descriptionItems?: CodingPlanCardCopyItem[];
};

const CODING_PLAN_CURRENCY_LABELS_ZH: Record<CodingPlanPriceCurrency, string> =
  {
    CNY: "人民币",
    USD: "美元",
  };

export const CODING_PLAN_PERIODS: CodingPlanBillingPeriod[] = [
  "monthly",
  "quarterly",
  "yearly",
];

export const CODING_PLAN_PERIOD_LABEL_IDS: Record<
  CodingPlanBillingPeriod,
  string
> = {
  monthly: "settings.modelProvider.codingPlan.period.monthly",
  quarterly: "settings.modelProvider.codingPlan.period.quarterly",
  yearly: "settings.modelProvider.codingPlan.period.yearly",
};

export function groupProductsByPeriod(
  productList: CodingPlanProductDisplay[],
): Record<CodingPlanBillingPeriod, CodingPlanProductDisplay[]> {
  const groups: Record<CodingPlanBillingPeriod, CodingPlanProductDisplay[]> = {
    monthly: [],
    quarterly: [],
    yearly: [],
  };

  for (const product of productList) {
    groups[inferBillingPeriod(product)].push(product);
  }

  for (const period of CODING_PLAN_PERIODS) {
    groups[period].sort(compareCodingPlanProduct);
  }

  return groups;
}

export function pickProductTitle(
  product: CodingPlanProductPreviewPayment,
): string {
  return (
    product.productName?.trim() ||
    product.productBigTitle?.trim() ||
    product.productId
  );
}

export function pickProductDetails(
  product: CodingPlanProductPreviewPayment,
): string[] {
  // 修复原因：套餐卡片的运营文案现在由静态配置的 description 控制；
  // 继续优先拼 productEquityList 会展示旧权益字段，和服务端配置的套餐说明不一致。
  const descriptionDetails = [
    product.productDescription?.trim(),
    product.productIntroduction?.trim(),
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) =>
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .slice(0, 4);
  if (descriptionDetails.length > 0) {
    return descriptionDetails;
  }

  return (product.productEquityList ?? [])
    .map((equity) =>
      [equity.productEquityTitle?.trim(), equity.productEquityDetails?.trim()]
        .filter(Boolean)
        .join("："),
    )
    .filter(Boolean)
    .slice(0, 4);
}

export function pickProductPrice(
  product: CodingPlanProductPreviewPayment,
): number | null {
  return (
    product.payAmount ?? product.discountAmount ?? product.renewAmount ?? null
  );
}

export function normalizeCodingPlanCurrency(
  currency: string | null | undefined,
): CodingPlanPriceCurrency {
  return currency?.trim().toUpperCase() === "USD" ? "USD" : "CNY";
}

export function formatCodingPlanAmount(
  amount: number,
  currency: string | null | undefined,
  locale: string,
): string {
  const resolvedCurrency = normalizeCodingPlanCurrency(currency);
  const isChineseLocale = locale.toLowerCase().startsWith("zh");
  const formattedAmount = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  const currencyPrefix = isChineseLocale
    ? resolvedCurrency === "USD"
      ? "$"
      : "¥"
    : resolvedCurrency === "USD"
      ? "US$"
      : "CN¥";
  const formatted = `${currencyPrefix}${formattedAmount}`;

  // 套餐页需要同时展示中英文和跨币种价格；依赖 Intl currency 会在不同 locale 下输出
  // 不一致的 ISO code/符号组合，因此这里按产品文案规范固定符号和中文币种名。
  return isChineseLocale
    ? `${formatted} ${CODING_PLAN_CURRENCY_LABELS_ZH[resolvedCurrency]}`
    : formatted;
}

export function inferBillingPeriod(
  product: CodingPlanProductPreviewPayment,
): CodingPlanBillingPeriod {
  const explicitUnit = product.priceUnit;
  if (explicitUnit) {
    // Bugfix: Z.AI 海外套餐会直接返回 priceUnit，优先使用后端给出的计费周期，避免英文商品名或金额折算造成误判。
    return explicitUnit === "year"
      ? "yearly"
      : explicitUnit === "quarter"
        ? "quarterly"
        : "monthly";
  }

  const pack = product.relateResourcePack ?? "";
  if (/包年|-\s*年|year/i.test(pack)) {
    return "yearly";
  }
  if (/包季|-\s*季|quarter/i.test(pack)) {
    return "quarterly";
  }
  if (/包月|-\s*月|month/i.test(pack)) {
    return "monthly";
  }

  const monthlyAmount =
    product.monthlyOriginalAmount ?? product.monthlyPayAmount;
  const totalAmount = product.originalAmount ?? product.payAmount;
  if (typeof monthlyAmount === "number" && typeof totalAmount === "number") {
    const ratio = Math.round(totalAmount / monthlyAmount);
    if (ratio >= 10) {
      return "yearly";
    }
    if (ratio >= 2) {
      return "quarterly";
    }
  }

  return "monthly";
}

function compareCodingPlanProduct(
  left: CodingPlanProductDisplay,
  right: CodingPlanProductDisplay,
): number {
  return productLevelRank(left) - productLevelRank(right);
}

function productLevelRank(product: CodingPlanProductPreviewPayment): number {
  const name = product.productName?.toLowerCase() ?? "";
  if (name.includes("start")) {
    return -1;
  }
  if (name.includes("lite")) {
    return 0;
  }
  if (name.includes("pro")) {
    return 1;
  }
  if (name.includes("max")) {
    return 2;
  }
  return 3;
}
