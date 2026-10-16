import { describe, expect, it } from "vitest";
import {
  buildEnterpriseCodingPlanCampaignDiscountDetails,
  buildEnterpriseCodingPlanCreateOrderRequest,
  buildEnterpriseCodingPlanEstimateFromPendingOrder,
  buildEnterpriseCodingPlanPaymentContent,
  buildEnterpriseCodingPlanProductList,
  calculateEnterpriseCodingPlanPricingDiscountAmount,
  getEnterpriseCodingPlanFailureStatuses,
  isEnterpriseCodingPlanThirdPartyPaymentRequired,
  isEnterpriseCodingPlanPaymentFailureStatus,
  isEnterpriseCodingPlanPaymentSuccessStatus,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";

describe("Enterprise Coding Plan products", () => {
  it("按后端下发顺序展示企业套餐，并保留 subscribeMode 和采购方式", () => {
    const products = buildEnterpriseCodingPlanProductList([
      {
        productId: "enterprise-lite-monthly",
        tier: "LITE",
        subscribeMode: "ONE_TIME",
        subscribePeriod: "MONTHLY",
        purchaseMethodName: "按月采购",
        payAmount: 270,
      },
      {
        productId: "enterprise-pro-yearly",
        tier: "PRO",
        subscribeMode: "ONE_TIME",
        subscribePeriod: "YEARLY",
        purchaseMethodName: "按年采购",
        payAmount: 2700,
      },
      {
        productId: "enterprise-lite-continuous-monthly",
        tier: "LITE",
        subscribeMode: "CONTINUOUS",
        subscribePeriod: "MONTHLY",
        purchaseMethodName: "连续包月",
        payAmount: 243,
      },
      {
        productId: "enterprise-max-monthly",
        tier: "MAX",
        subscribeMode: "ONE_TIME",
        subscribePeriod: "MONTHLY",
        purchaseMethodName: "按月采购",
        payAmount: 900,
      },
    ]);

    expect(products.map((product) => product.productId)).toEqual([
      "enterprise-lite-monthly",
      "enterprise-pro-yearly",
      "enterprise-lite-continuous-monthly",
      "enterprise-max-monthly",
    ]);
    expect(products.map((product) => product.productName)).toEqual([
      "Lite",
      "Pro",
      "Lite",
      "Max",
    ]);
    expect(products.map((product) => product.priceUnit)).toEqual([
      "month",
      "year",
      "month",
      "month",
    ]);
    expect(products.map((product) => product.purchaseMethodName)).toEqual([
      "按月采购",
      "按年采购",
      "连续包月",
      "按月采购",
    ]);
  });

  it("企业卡片价格字段对齐个人套餐：主价用 payAmount，原价用 originalAmount，不把优惠金额当价格", () => {
    const [monthlyProduct, continuousYearlyProduct, oneTimeYearlyProduct] =
      buildEnterpriseCodingPlanProductList([
      {
        productId: "enterprise-pro-monthly",
        tier: "PRO",
        subscribeMode: "ONE_TIME",
        subscribePeriod: "MONTHLY",
        purchaseMethodName: "按月采购",
        originalAmount: 720,
        discountAmount: 72,
        payAmount: 648,
        renewAmount: 648,
      },
      {
        productId: "enterprise-pro-continuous-yearly",
        tier: "PRO",
        subscribeMode: "CONTINUOUS",
        subscribePeriod: "YEARLY",
        purchaseMethodName: "连续包年",
        originalAmount: 7176,
        discountAmount: 0,
        payAmount: 7176,
        renewAmount: 6458.4,
      },
      {
        productId: "enterprise-pro-yearly",
        tier: "PRO",
        subscribeMode: "ONE_TIME",
        subscribePeriod: "YEARLY",
        purchaseMethodName: "按年采购",
        originalAmount: 7176,
        discountAmount: 0,
        payAmount: 7176,
        renewAmount: 6458.4,
      },
    ]);

    expect(monthlyProduct).toMatchObject({
      originalAmount: 720,
      payAmount: 648,
      renewAmount: 648,
    });
    expect(monthlyProduct.discountAmount).toBeUndefined();
    expect(monthlyProduct.enterpriseProduct.discountAmount).toBe(72);
    expect(continuousYearlyProduct).toMatchObject({
      originalAmount: 7176,
      payAmount: 6458.4,
      priceUnit: "year",
    });
    expect(continuousYearlyProduct.discountAmount).toBeUndefined();
    expect(oneTimeYearlyProduct).toMatchObject({
      originalAmount: 7176,
      payAmount: 6458.4,
      priceUnit: "year",
    });
    expect(oneTimeYearlyProduct.discountAmount).toBeUndefined();
  });

  it("把企业折扣明细转换为支付弹窗活动优惠明细", () => {
    expect(
      buildEnterpriseCodingPlanCampaignDiscountDetails({
        campaignDiscountAmount: 270,
        discountDetails: [
          {
            discountType: "REGULAR_DISCOUNT",
            discountName: "企业套餐九折",
            discountAmount: 270,
          },
        ],
      }),
    ).toEqual([
      {
        campaignName: "企业套餐九折",
        campaignDiscountAmount: 270,
        rewardDetail: "企业套餐九折",
        applyScene: "REGULAR_DISCOUNT",
      },
    ]);

    expect(
      buildEnterpriseCodingPlanCampaignDiscountDetails({
        campaignDiscountAmount: 270,
        discountDetails: [],
      }),
    ).toEqual([
      {
        campaignDiscountAmount: 270,
      },
    ]);
  });

  it("优先使用 pricing 下发的 campaignDiscountDetails 展示企业活动信息，并使用订单总优惠金额", () => {
    expect(
      buildEnterpriseCodingPlanCampaignDiscountDetails({
        campaignDiscountAmount: 216,
        discountDetails: [],
        pricingCampaignDiscountDetails: [
          {
            campaignName: "连续包季 9折",
            campaignDiscountAmount: 72,
            rewardMode: "PERCENT",
            rewardAmount: 10,
            rewardDetail: "连续包月享9折优惠",
            applyScene: "SUBSCRIPTION",
          },
        ],
      }),
    ).toEqual([
      {
        campaignName: "连续包季 9折",
        campaignDiscountAmount: 216,
        rewardMode: "PERCENT",
        rewardAmount: 10,
        rewardDetail: "连续包月享9折优惠",
        applyScene: "SUBSCRIPTION",
      },
    ]);
  });

  it("试算未返回汇总优惠时，用 pricing 顶层 discountAmount 按席位和时长折算", () => {
    const [monthlyOneTimeProduct, yearlyContinuousProduct] =
      buildEnterpriseCodingPlanProductList([
        {
          productId: "enterprise-pro-monthly",
          tier: "PRO",
          subscribeMode: "ONE_TIME",
          subscribePeriod: "MONTHLY",
          purchaseMethodName: "按月采购",
          originalAmount: 720,
          discountAmount: 72,
          payAmount: 648,
          renewAmount: 648,
        },
        {
          productId: "enterprise-pro-continuous-yearly",
          tier: "PRO",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "YEARLY",
          purchaseMethodName: "连续包年",
          originalAmount: 7176,
          discountAmount: 0,
          payAmount: 7176,
          renewAmount: 6458.4,
        },
      ]);

    expect(
      calculateEnterpriseCodingPlanPricingDiscountAmount({
        product: monthlyOneTimeProduct,
        maxSeats: 3,
        duration: 2,
      }),
    ).toBe(432);
    expect(
      calculateEnterpriseCodingPlanPricingDiscountAmount({
        product: yearlyContinuousProduct,
        maxSeats: 3,
        duration: 2,
      }),
    ).toBe(2152.8);
  });

  it("多条 pricing 活动按下发金额比例分摊订单总优惠", () => {
    expect(
      buildEnterpriseCodingPlanCampaignDiscountDetails({
        campaignDiscountAmount: 300,
        pricingCampaignDiscountDetails: [
          {
            campaignName: "活动 A",
            campaignDiscountAmount: 20,
          },
          {
            campaignName: "活动 B",
            campaignDiscountAmount: 10,
          },
        ],
      }),
    ).toEqual([
      {
        campaignName: "活动 A",
        campaignDiscountAmount: 200,
      },
      {
        campaignName: "活动 B",
        campaignDiscountAmount: 100,
      },
    ]);
  });

  it("ONE_TIME 下单请求包含 duration，并原样回传试算金额", () => {
    const product = buildEnterpriseCodingPlanProductList([
      {
        productId: "enterprise-lite-monthly",
        tier: "LITE",
        subscribeMode: "ONE_TIME",
        subscribePeriod: "MONTHLY",
        purchaseMethodName: "按月采购",
        payAmount: 270,
      },
    ])[0];

    expect(
      buildEnterpriseCodingPlanCreateOrderRequest({
        product,
        maxSeats: 3,
        duration: 2,
        estimate: {
          totalOriginalAmount: 1620,
          totalPayAmount: 1458,
          thirdPayAmount: 1458,
        },
      }),
    ).toMatchObject({
      productId: "enterprise-lite-monthly",
      maxSeats: 3,
      subscribeMode: "ONE_TIME",
      subscribePeriod: "MONTHLY",
      purchaseType: "PAY",
      duration: 2,
      giveAmount: 0,
      balanceDeductAmount: 0,
      totalOriginalAmount: 1620,
      totalPayAmount: 1458,
      thirdPayAmount: 1458,
    });
  });

  it("支付内容优先使用 payUrl，否则使用 alipayJumpSchema", () => {
    expect(
      buildEnterpriseCodingPlanPaymentContent({
        orderNo: "order-1",
        totalOriginalAmount: 100,
        totalPayAmount: 90,
        thirdPayAmount: 90,
        alipayJumpSchema: "alipays://pay",
        payUrl: "https://pay.example",
      }),
    ).toBe("https://pay.example");
    expect(
      buildEnterpriseCodingPlanPaymentContent({
        orderNo: "order-2",
        totalOriginalAmount: 100,
        totalPayAmount: 90,
        thirdPayAmount: 90,
        alipayJumpSchema: "alipays://pay",
      }),
    ).toBe("alipays://pay");
  });

  it("余额全额抵扣且无支付内容时不要求三方支付", () => {
    expect(
      isEnterpriseCodingPlanThirdPartyPaymentRequired({
        orderNo: "order-free",
        totalOriginalAmount: 100,
        totalPayAmount: 100,
        thirdPayAmount: 0,
      }),
    ).toBe(false);
    expect(
      isEnterpriseCodingPlanThirdPartyPaymentRequired({
        orderNo: "order-pay",
        totalOriginalAmount: 100,
        totalPayAmount: 100,
        thirdPayAmount: 0,
        payUrl: "https://pay.example",
      }),
    ).toBe(true);
  });

  it("把企业待支付订单映射为确认页试算金额", () => {
    expect(
      buildEnterpriseCodingPlanEstimateFromPendingOrder({
        orderNo: "order-pending",
        productId: "enterprise-lite-monthly",
        amount: 2430,
        totalAmount: 2700,
        deductionAmount: 270,
        paymentStatus: "WAIT_PAY",
        createTime: "2026-05-09 14:30:00",
        subscriptionNo: "SUB20260513a1b2c3d4",
        seatCount: 10,
      }),
    ).toEqual({
      totalOriginalAmount: 2700,
      campaignDiscountAmount: 270,
      totalPayAmount: 2430,
      thirdPayAmount: 2430,
    });
  });

  it("识别企业支付成功和失败终态", () => {
    expect(isEnterpriseCodingPlanPaymentSuccessStatus("SUCCESS")).toBe(true);
    expect(isEnterpriseCodingPlanPaymentSuccessStatus("WAIT_PAY")).toBe(false);
    for (const status of getEnterpriseCodingPlanFailureStatuses()) {
      expect(isEnterpriseCodingPlanPaymentFailureStatus(status)).toBe(true);
    }
  });
});
