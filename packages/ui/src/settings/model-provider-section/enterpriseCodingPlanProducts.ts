/* eslint-disable max-lines -- 企业套餐展示模型集中承载静态目录、实时定价与支付参数转换，拆分会模糊合并边界。 */
import type {
  CodingPlanCampaignDiscountDetail,
  CodingPlanStaticTeamProduct,
  EnterpriseCodingPlanCreateOrderRequest,
  EnterpriseCodingPlanCreateOrderResponse,
  EnterpriseCodingPlanDiscountDetail,
  EnterpriseCodingPlanOrderCalculateResponse,
  EnterpriseCodingPlanPendingOrder,
  EnterpriseCodingPlanPaymentStatus,
  EnterpriseCodingPlanPricingProduct,
  EnterpriseCodingPlanSubscribePeriod,
  ProviderFamilyDomain,
} from "@zcode/shared";
import {
  normalizeCodingPlanCardCopyItems,
  type CodingPlanPriceUnit,
  type CodingPlanProductDisplay,
} from "@/settings/model-provider-section/codingPlanProductPresentation.js";

export type EnterpriseCodingPlanProductDisplay = CodingPlanProductDisplay & {
  enterpriseProduct: EnterpriseCodingPlanPricingProduct;
  tier: EnterpriseCodingPlanPricingProduct["tier"];
  subscribeMode: EnterpriseCodingPlanPricingProduct["subscribeMode"];
  subscribePeriod: EnterpriseCodingPlanPricingProduct["subscribePeriod"];
  purchaseMethodName: string;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  teamProjects?: EnterpriseCodingPlanPricingProduct["teamProjects"];
  apiKeyStatus?: EnterpriseCodingPlanPricingProduct["apiKeyStatus"];
  apiKeyUnavailableReason?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableReason"];
  apiKeyUnavailableMessage?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableMessage"];
  subscribed?: boolean | null;
  dynamicPricingAvailable?: boolean;
  staticCatalogAvailable?: boolean;
  /**
   * 该企业套餐所属的 family（zai / bigmodel）。
   * 原 UI 层把 team plan items 硬编码为 bigmodelCodingPlan 派生，
   * zai family 即使有订阅也无法渲染。加 family 标记后，下游可见性函数可按
   * product.family 找到对应 family 的 codingPlanItem 和 team key 前缀。
   * 缺省 bigmodel 保持向后兼容。
   */
  family?: ProviderFamilyDomain;
};

/** 旧商品缺少 family 时只在这一规范化边界解释为 BigModel。 */
export function resolveEnterpriseCodingPlanProductFamily(
  product: Pick<EnterpriseCodingPlanProductDisplay, "family">,
): ProviderFamilyDomain {
  return product.family ?? "bigmodel";
}

const ENTERPRISE_CODING_PLAN_FAILURE_STATUSES = ["FAIL", "CLOSED", "CANCELLED"] as const;

export function buildEnterpriseCodingPlanProductList(
  products: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  return products.map((product): EnterpriseCodingPlanProductDisplay => {
    const purchaseMethodName = product.purchaseMethodName?.trim() ?? "";
    return {
      productId: product.productId,
      productName: formatEnterpriseCodingPlanTier(product.tier),
      productBigTitle: formatEnterpriseCodingPlanTier(product.tier),
      originalAmount: product.originalAmount,
      payAmount: resolveEnterpriseCodingPlanDisplayPayAmount(product),
      renewAmount: product.renewAmount,
      canRepurchase: product.canRepurchase,
      inCurrentPeriod: product.subscribed === true,
      campaignDiscountDetails: product.campaignDiscountDetails,
      priceUnit: mapEnterpriseCodingPlanPriceUnit(product.subscribePeriod),
      priceCurrency: "CNY",
      productEquityList: [],
      hasPreview: true,
      enterpriseProduct: product,
      tier: product.tier,
      subscribeMode: product.subscribeMode,
      subscribePeriod: product.subscribePeriod,
      purchaseMethodName,
      organizationId: product.organizationId,
      organizationName: product.organizationName,
      projectId: product.projectId,
      projectName: product.projectName,
      teamProjects: product.teamProjects,
      apiKeyStatus: product.apiKeyStatus,
      apiKeyUnavailableReason: product.apiKeyUnavailableReason,
      apiKeyUnavailableMessage: product.apiKeyUnavailableMessage,
      subscribed: product.subscribed,
      dynamicPricingAvailable: true,
    };
  });
}

export function mergeEnterpriseCodingPlanProductList(
  staticProducts: CodingPlanStaticTeamProduct[],
  pricingProducts: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  const pricingByProductId = new Map(
    pricingProducts.map((product) => [product.productId, product]),
  );
  const staticProductIds = new Set(staticProducts.map((product) => product.productId));
  const mergedStaticProducts = staticProducts.map((staticProduct) => {
    const pricingProduct = pricingByProductId.get(staticProduct.productId);
    const enterpriseProduct: EnterpriseCodingPlanPricingProduct = pricingProduct ?? {
      productId: staticProduct.productId,
      tier: staticProduct.tier,
      subscribeMode: staticProduct.subscribeMode,
      subscribePeriod: staticProduct.subscribePeriod,
      purchaseMethodName: staticProduct.purchaseMethodName,
      originalAmount: staticProduct.originalAmount,
      discountAmount: staticProduct.discountAmount,
      payAmount: staticProduct.payAmount,
      renewAmount: staticProduct.renewAmount,
      canRepurchase: false,
    };
    const display = buildEnterpriseCodingPlanProductList([enterpriseProduct])[0]!;
    return {
      ...display,
      productName: staticProduct.productName,
      productBigTitle: staticProduct.productName,
      originalAmount: pricingProduct?.originalAmount ?? staticProduct.originalAmount,
      payAmount: pricingProduct
        ? display.payAmount
        : (staticProduct.payAmount ?? staticProduct.renewAmount),
      renewAmount: pricingProduct?.renewAmount ?? staticProduct.renewAmount,
      priceCurrency: staticProduct.priceCurrency,
      equity: normalizeCodingPlanCardCopyItems(staticProduct.equity ?? []),
      descriptionItems: normalizeCodingPlanCardCopyItems(staticProduct.description ?? []),
      dynamicPricingAvailable: pricingProduct !== undefined,
      staticCatalogAvailable: true,
    };
  });
  const purchasedPricingProducts = pricingProducts
    .filter((product) => product.subscribed === true && !staticProductIds.has(product.productId))
    .map((product) => ({
      ...buildEnterpriseCodingPlanProductList([product])[0]!,
      // client/configs 的团队静态目录只负责可购买 SKU 展示；
      // 已购 Team Plan 身份来自 pricing/customerInfo，不能因为静态目录灰度为空或漏发商品
      // 就把真实团队连接方式和使用统计入口隐藏。
      staticCatalogAvailable: false,
    }));
  return [...mergedStaticProducts, ...purchasedPricingProducts];
}

export function resolveEnterpriseCodingPlanProductList(
  staticProducts: CodingPlanStaticTeamProduct[] | undefined,
  pricingProducts: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  // 静态目录缺失或读取失败时，pricing 仍是团队订阅身份与项目上下文的权威来源；
  // 只有成功读取到显式空数组时，才按配置语义隐藏全部团队 SKU。
  return !Array.isArray(staticProducts)
    ? buildEnterpriseCodingPlanProductList(pricingProducts)
    : mergeEnterpriseCodingPlanProductList(staticProducts, pricingProducts);
}

function resolveEnterpriseCodingPlanDisplayPayAmount(
  product: EnterpriseCodingPlanPricingProduct,
): number | undefined {
  const candidateAmounts = [product.payAmount, product.renewAmount].filter(hasPositiveOrZeroAmount);
  if (candidateAmounts.length > 0) {
    // 真实企业 pricing 年付商品会下发 payAmount=originalAmount、renewAmount=折后价。
    // 卡片要和个人套餐一致展示“折后价 + 原价划线”，因此显示价取可用支付金额里的最低值。
    return Math.min(...candidateAmounts);
  }
  if (
    hasPositiveOrZeroAmount(product.originalAmount) &&
    hasPositiveAmount(product.discountAmount)
  ) {
    // 个人套餐卡片展示的是折后价 + 原价划线；企业 pricing 的 discountAmount 是优惠金额，
    // 不能直接传给通用卡片当价格，但年付商品可能只下发 originalAmount + discountAmount。
    return roundCurrencyAmount(Math.max(0, product.originalAmount - product.discountAmount));
  }
  return undefined;
}

export function buildEnterpriseCodingPlanCalculateRequest({
  product,
  maxSeats,
  duration,
  giveAmount = 0,
  balanceDeductAmount = 0,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
  giveAmount?: number;
  balanceDeductAmount?: number;
}) {
  return {
    productId: product.productId,
    maxSeats,
    subscribePeriod: product.subscribePeriod,
    subscribeMode: product.subscribeMode,
    duration: product.subscribeMode === "ONE_TIME" ? duration : undefined,
    giveAmount,
    balanceDeductAmount,
  };
}

export function buildEnterpriseCodingPlanCreateOrderRequest({
  product,
  maxSeats,
  duration,
  estimate,
  giveAmount = 0,
  balanceDeductAmount = 0,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
  giveAmount?: number;
  balanceDeductAmount?: number;
  estimate: Pick<
    EnterpriseCodingPlanOrderCalculateResponse,
    "totalOriginalAmount" | "totalPayAmount" | "thirdPayAmount"
  >;
}): EnterpriseCodingPlanCreateOrderRequest {
  return {
    productId: product.productId,
    maxSeats,
    subscribePeriod: product.subscribePeriod,
    subscribeMode: product.subscribeMode,
    purchaseType: "PAY",
    duration: product.subscribeMode === "ONE_TIME" ? duration : undefined,
    giveAmount,
    balanceDeductAmount,
    totalOriginalAmount: estimate.totalOriginalAmount,
    totalPayAmount: estimate.totalPayAmount,
    thirdPayAmount: estimate.thirdPayAmount,
  };
}

export function buildEnterpriseCodingPlanPaymentContent(
  order: Pick<EnterpriseCodingPlanCreateOrderResponse, "alipayJumpSchema" | "payUrl">,
): string {
  // Bugfix: 企业套餐 PC 扫码二维码按接口文档使用 payUrl；alipayJumpSchema 是移动端拉起支付宝的 schema，内容过长时会导致二维码生成失败。
  return order.payUrl?.trim() || order.alipayJumpSchema?.trim() || "";
}

export function isEnterpriseCodingPlanThirdPartyPaymentRequired(
  order: Pick<
    EnterpriseCodingPlanCreateOrderResponse,
    "alipayJumpSchema" | "payUrl" | "thirdPayAmount"
  >,
): boolean {
  // Bugfix: 企业套餐使用赠金/余额全额抵扣时，后端会创建无三方支付内容的订单。
  // 这种订单不应该进入支付宝二维码页，否则用户会卡在“当前支付页完成支付”。
  return order.thirdPayAmount > 0 || buildEnterpriseCodingPlanPaymentContent(order) !== "";
}

export function buildEnterpriseCodingPlanEstimateFromPendingOrder(
  order: EnterpriseCodingPlanPendingOrder,
): EnterpriseCodingPlanOrderCalculateResponse {
  const discountAmount = hasPositiveAmount(order.deductionAmount)
    ? order.deductionAmount
    : Math.max(0, order.totalAmount - order.amount);
  return {
    totalOriginalAmount: order.totalAmount,
    campaignDiscountAmount: discountAmount,
    totalPayAmount: order.amount,
    // Bugfix: 待支付订单列表接口没有 thirdPayAmount 字段，确认页必须用待支付实付金额占位；
    // 真正拉起支付时会再用继续支付接口返回的 thirdPayAmount 刷新二维码弹窗金额。
    thirdPayAmount: order.amount,
  };
}

export function buildEnterpriseCodingPlanEstimateFromOrderResponse(
  order: EnterpriseCodingPlanCreateOrderResponse,
): EnterpriseCodingPlanOrderCalculateResponse {
  return {
    totalOriginalAmount: order.totalOriginalAmount,
    campaignDiscountAmount: order.campaignDiscountAmount,
    discountDetails: order.discountDetails,
    totalPayAmount: order.totalPayAmount,
    thirdPayAmount: order.thirdPayAmount,
  };
}

export function buildEnterpriseCodingPlanCampaignDiscountDetails({
  campaignDiscountAmount,
  discountDetails,
  pricingCampaignDiscountDetails,
}: {
  campaignDiscountAmount?: number;
  discountDetails?: EnterpriseCodingPlanDiscountDetail[];
  pricingCampaignDiscountDetails?: CodingPlanCampaignDiscountDetail[];
}): CodingPlanCampaignDiscountDetail[] {
  const pricingDetails = normalizePricingCampaignDiscountDetails(
    pricingCampaignDiscountDetails,
    campaignDiscountAmount,
  );
  if (pricingDetails.length > 0) {
    return pricingDetails;
  }

  const mappedDetails = (discountDetails ?? []).flatMap((detail) => {
    if (typeof detail.discountAmount !== "number" || detail.discountAmount <= 0) {
      return [];
    }
    const discountName = detail.discountName?.trim();
    return [
      {
        campaignName: discountName || undefined,
        campaignDiscountAmount: detail.discountAmount,
        rewardDetail: discountName || undefined,
        applyScene: detail.discountType,
      },
    ];
  });
  if (mappedDetails.length > 0) {
    return mappedDetails;
  }
  if (typeof campaignDiscountAmount === "number" && campaignDiscountAmount > 0) {
    return [{ campaignDiscountAmount }];
  }
  return [];
}

export function calculateEnterpriseCodingPlanPricingDiscountAmount({
  product,
  maxSeats,
  duration,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
}): number | undefined {
  const discountAmount = product.enterpriseProduct.discountAmount;
  const displayDiscountAmount = hasPositiveAmount(discountAmount)
    ? discountAmount
    : calculateEnterpriseCodingPlanDisplayDiscountAmount(product);
  if (!hasPositiveAmount(displayDiscountAmount)) {
    return undefined;
  }
  const periodCount = product.subscribeMode === "ONE_TIME" ? Math.max(1, duration) : 1;
  return roundCurrencyAmount(
    // 修复原因：企业 pricing 的 discountAmount 可能为 0，真实年付折扣体现在 originalAmount 与 renewAmount 差额；
    // 这里按卡片展示价还原单席位优惠金额，参与确认/支付明细。
    displayDiscountAmount * Math.max(1, maxSeats) * periodCount,
  );
}

function calculateEnterpriseCodingPlanDisplayDiscountAmount(
  product: EnterpriseCodingPlanProductDisplay,
): number | undefined {
  const displayPayAmount = resolveEnterpriseCodingPlanDisplayPayAmount(product.enterpriseProduct);
  if (
    !hasPositiveAmount(product.enterpriseProduct.originalAmount) ||
    !hasPositiveOrZeroAmount(displayPayAmount)
  ) {
    return undefined;
  }
  const discountAmount = product.enterpriseProduct.originalAmount - displayPayAmount;
  return discountAmount > 0 ? roundCurrencyAmount(discountAmount) : undefined;
}

function normalizePricingCampaignDiscountDetails(
  details: CodingPlanCampaignDiscountDetail[] | undefined,
  campaignDiscountAmount: number | undefined,
): CodingPlanCampaignDiscountDetail[] {
  const sourceDetails = (details ?? []).filter(
    (detail) =>
      hasPositiveAmount(detail.campaignDiscountAmount) ||
      Boolean(detail.campaignName?.trim()) ||
      Boolean(detail.rewardDetail?.trim()),
  );
  if (sourceDetails.length === 0) {
    return [];
  }

  const totalDiscountAmount = hasPositiveAmount(campaignDiscountAmount)
    ? campaignDiscountAmount
    : undefined;
  const sourceAmountSum = sourceDetails.reduce(
    (sum, detail) =>
      sum + (hasPositiveAmount(detail.campaignDiscountAmount) ? detail.campaignDiscountAmount : 0),
    0,
  );
  let allocatedAmount = 0;

  return sourceDetails.flatMap((detail, index) => {
    const amount = resolvePricingCampaignDiscountAmount({
      detail,
      index,
      count: sourceDetails.length,
      totalDiscountAmount,
      sourceAmountSum,
      allocatedAmount,
    });
    allocatedAmount += amount;
    if (!hasPositiveAmount(amount)) {
      return [];
    }
    return [
      {
        ...detail,
        // 修复原因：企业 pricing 返回的是单席位/单周期活动信息，试算/下单返回的是当前席位和时长的总优惠；
        // 展示时保留 pricing 的活动名与说明，但金额必须使用当前订单总优惠，避免多席位采购折扣显示偏小。
        campaignDiscountAmount: amount,
      },
    ];
  });
}

function resolvePricingCampaignDiscountAmount({
  detail,
  index,
  count,
  totalDiscountAmount,
  sourceAmountSum,
  allocatedAmount,
}: {
  detail: CodingPlanCampaignDiscountDetail;
  index: number;
  count: number;
  totalDiscountAmount: number | undefined;
  sourceAmountSum: number;
  allocatedAmount: number;
}): number {
  if (!hasPositiveAmount(totalDiscountAmount)) {
    return hasPositiveAmount(detail.campaignDiscountAmount) ? detail.campaignDiscountAmount : 0;
  }

  if (count === 1) {
    return totalDiscountAmount;
  }

  if (sourceAmountSum <= 0) {
    return index === 0 ? totalDiscountAmount : 0;
  }

  if (index === count - 1) {
    return roundCurrencyAmount(totalDiscountAmount - allocatedAmount);
  }

  const sourceAmount = hasPositiveAmount(detail.campaignDiscountAmount)
    ? detail.campaignDiscountAmount
    : 0;
  return roundCurrencyAmount((totalDiscountAmount * sourceAmount) / sourceAmountSum);
}

function hasPositiveAmount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasPositiveOrZeroAmount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function roundCurrencyAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function isEnterpriseCodingPlanPaymentSuccessStatus(
  status: EnterpriseCodingPlanPaymentStatus,
): boolean {
  return status === "SUCCESS";
}

export function isEnterpriseCodingPlanPaymentFailureStatus(
  status: EnterpriseCodingPlanPaymentStatus,
): boolean {
  return ENTERPRISE_CODING_PLAN_FAILURE_STATUSES.includes(
    status as (typeof ENTERPRISE_CODING_PLAN_FAILURE_STATUSES)[number],
  );
}

export function getEnterpriseCodingPlanFailureStatuses(): string[] {
  return [...ENTERPRISE_CODING_PLAN_FAILURE_STATUSES];
}

function formatEnterpriseCodingPlanTier(tier: EnterpriseCodingPlanPricingProduct["tier"]): string {
  const normalized = tier.trim();
  if (!normalized) {
    return tier;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function mapEnterpriseCodingPlanPriceUnit(
  period: EnterpriseCodingPlanSubscribePeriod,
): CodingPlanPriceUnit {
  return period === "YEARLY" ? "year" : period === "QUARTERLY" ? "quarter" : "month";
}
