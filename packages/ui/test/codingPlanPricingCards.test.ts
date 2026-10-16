import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS, CODING_PLAN_SYSTEM_BUSY } from "@zcode/shared";
import { resolveCodingPlanUpgradeProductsProviderId } from "@/settings/model-provider-section/codingPlanPricingCards.js";
import {
  formatCodingPlanAmount,
  normalizeCodingPlanCardCopyItems,
} from "@/settings/model-provider-section/codingPlanProductPresentation.js";
import {
  clearCodingPlanProductsCacheForTest,
  loadCodingPlanStaticProductsSnapshotForTest,
  loadCodingPlanStaticProductListForTest,
  loadCodingPlanProductsForTest,
  normalizeErrorMessage,
  resolveCodingPlanProductsFailureSnapshot,
} from "@/settings/model-provider-section/useCodingPlanProducts.js";

// 原生购买面板（CodingPlanPurchasePanel / CodingPlanProductCards）已下线，
// 购买流程改为 webview 弹窗；本文件只保留仍针对活代码的用例。

afterEach(() => {
  clearCodingPlanProductsCacheForTest();
  vi.restoreAllMocks();
});

describe("CodingPlanProductCards", () => {
  it("formats coding plan prices by locale and currency", () => {
    expect(formatCodingPlanAmount(48.6, "USD", "en-US")).toBe("US$48.60");
    expect(formatCodingPlanAmount(48.6, "USD", "zh-CN")).toBe("$48.60 美元");
    expect(formatCodingPlanAmount(132.3, "CNY", "en-US")).toBe("CN¥132.30");
    expect(formatCodingPlanAmount(132.3, "CNY", "zh-CN")).toBe("¥132.30 人民币");
  });

  it("maps unrenderable payment errors to system busy guidance", () => {
    const htmlError =
      '<!doctypehtml><html lang="zh-cn"><title>405</title><body>Sorry, your request has been blocked as it may cause potential threats.</body></html>';

    expect(normalizeErrorMessage(new Error(htmlError))).toBe(CODING_PLAN_SYSTEM_BUSY);
    expect(
      normalizeErrorMessage(new Error("Unexpected token '<', \"<html\" is not valid JSON")),
    ).toBe(CODING_PLAN_SYSTEM_BUSY);
  });

  it("keeps the last preview snapshot when refresh fails", () => {
    const previewSnapshot = {
      productList: [
        {
          productId: "product-pro-quarter",
          productName: "Pro",
          priceUnit: "quarter",
          payAmount: 100,
          soldOut: true,
          hasPreview: true,
        },
      ],
      isSubscribed: false,
      isAuthenticated: true,
    };
    const staticFallback = {
      productList: [
        {
          productId: "product-pro-quarter",
          productName: "Pro",
          priceUnit: "quarter",
          payAmount: 100,
          hasPreview: false,
        },
      ],
      isSubscribed: false,
      isAuthenticated: null,
    };

    expect(
      resolveCodingPlanProductsFailureSnapshot(previewSnapshot, staticFallback).productList[0]
        ?.soldOut,
    ).toBe(true);
    expect(
      resolveCodingPlanProductsFailureSnapshot(null, staticFallback).productList[0]?.hasPreview,
    ).toBe(false);
  });

  it("caches successful batch-preview snapshots briefly and lets force bypass the cache", async () => {
    const batchPreview = vi
      .fn()
      .mockResolvedValueOnce({
        productList: [
          {
            productId: "product-e68d08",
            productName: "GLM Coding Lite",
            payAmount: 48.6,
            priceCurrency: "USD",
          },
        ],
        isSubscribed: false,
        isAuthenticated: true,
      })
      .mockResolvedValueOnce({
        productList: [
          {
            productId: "product-e68d08",
            productName: "GLM Coding Lite",
            payAmount: 50,
            priceCurrency: "USD",
          },
        ],
        isSubscribed: false,
        isAuthenticated: true,
      });
    const service = { batchPreview } as never;

    const first = await loadCodingPlanProductsForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      service,
      false,
    );
    const second = await loadCodingPlanProductsForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      service,
      false,
    );
    const forced = await loadCodingPlanProductsForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      service,
      true,
    );

    expect(batchPreview).toHaveBeenCalledTimes(2);
    expect(
      first.productList.find((product) => product.productId === "product-e68d08")?.payAmount,
    ).toBe(48.6);
    expect(
      second.productList.find((product) => product.productId === "product-e68d08")?.payAmount,
    ).toBe(48.6);
    expect(
      forced.productList.find((product) => product.productId === "product-e68d08")?.payAmount,
    ).toBe(50);
  });

  it("prevents stale in-flight previews from replacing a forced refresh cache", async () => {
    type PreviewSnapshot = {
      productList: Array<{
        productId: string;
        productName: string;
        payAmount: number;
        priceCurrency: string;
      }>;
      isSubscribed: boolean;
      isAuthenticated: boolean;
    };
    let resolveInitialPreview: ((snapshot: PreviewSnapshot) => void) | null = null;
    let resolveForcedPreview: ((snapshot: PreviewSnapshot) => void) | null = null;
    const initialPreview = new Promise<PreviewSnapshot>((resolve) => {
      resolveInitialPreview = resolve;
    });
    const forcedPreview = new Promise<PreviewSnapshot>((resolve) => {
      resolveForcedPreview = resolve;
    });
    const batchPreview = vi
      .fn()
      .mockReturnValueOnce(initialPreview)
      .mockReturnValueOnce(forcedPreview);
    const service = { batchPreview } as never;

    const initialLoad = loadCodingPlanProductsForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      service,
      false,
    );
    const forcedLoad = loadCodingPlanProductsForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      service,
      true,
    );

    resolveForcedPreview?.({
      productList: [
        {
          productId: "product-e68d08",
          productName: "GLM Coding Lite",
          payAmount: 50,
          priceCurrency: "USD",
        },
      ],
      isSubscribed: false,
      isAuthenticated: true,
    });
    const forced = await forcedLoad;

    resolveInitialPreview?.({
      productList: [
        {
          productId: "product-e68d08",
          productName: "GLM Coding Lite",
          payAmount: 10,
          priceCurrency: "USD",
        },
      ],
      isSubscribed: false,
      isAuthenticated: false,
    });
    await initialLoad;

    const cached = await loadCodingPlanProductsForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      service,
      false,
    );

    expect(batchPreview).toHaveBeenCalledTimes(2);
    expect(
      forced.productList.find((product) => product.productId === "product-e68d08")?.payAmount,
    ).toBe(50);
    expect(
      cached.productList.find((product) => product.productId === "product-e68d08")?.payAmount,
    ).toBe(50);
  });

  it("loads remote static products once per day while viewing plans", async () => {
    const getStaticProducts = vi.fn(async () => ({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: [
        {
          productId: "remote-zai-lite-quarter",
          productName: "Remote Lite",
          description: "old remote zai lite description",
          productEquityList: [
            {
              productEquityTitle: "Remote quota",
              productEquityDetails: "Daily cached",
            },
          ],
          priceUnit: "quarter",
          displayOrder: 1,
          priceCurrency: "USD",
          payAmount: 42,
        },
      ],
    }));
    const service = { getStaticProducts } as never;

    const first = await loadCodingPlanStaticProductListForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      service,
    );
    const second = await loadCodingPlanStaticProductListForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      service,
    );

    expect(getStaticProducts).toHaveBeenCalledTimes(1);
    expect(first[0]?.productId).toBe("remote-zai-lite-quarter");
    expect(first[0]?.description).toBe("old remote zai lite description");
    expect(second[0]?.productId).toBe("remote-zai-lite-quarter");
  });

  it("shows static products without calling batch-preview when remote preview is disabled", async () => {
    const batchPreview = vi.fn();
    const getStaticProducts = vi.fn(async () => ({
      [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: [
        {
          productId: "remote-bigmodel-lite-quarter",
          productName: "Remote BigModel Lite",
          description: ["旧远端 BigModel Lite 文案", "适配当前卡片布局"],
          productEquityList: [
            {
              productEquityTitle: "Remote quota",
              productEquityDetails: "Shown before login",
            },
          ],
          priceUnit: "quarter",
          displayOrder: 1,
          priceCurrency: "CNY",
          payAmount: 128,
        },
      ],
    }));
    const service = { batchPreview, getStaticProducts } as never;

    const snapshot = await loadCodingPlanStaticProductsSnapshotForTest(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      service,
    );

    expect(batchPreview).not.toHaveBeenCalled();
    expect(snapshot.productList).toHaveLength(1);
    expect(snapshot.productList[0]?.productId).toBe("remote-bigmodel-lite-quarter");
    expect(snapshot.productList[0]?.productDescription).toBe(
      "旧远端 BigModel Lite 文案\n适配当前卡片布局",
    );
    expect(snapshot.productList[0]?.hasPreview).toBe(false);
  });

  it("keeps remote Coding Plan static product descriptions", async () => {
    const getStaticProducts = vi.fn(async () => ({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: [
        {
          productId: "zai-lite",
          productName: "GLM Coding Lite",
          description: "old zai lite",
          productEquityList: [],
          priceUnit: "month",
          displayOrder: 1,
          priceCurrency: "USD",
        },
        {
          productId: "zai-pro",
          productName: "GLM Coding Pro",
          description: "old zai pro",
          productEquityList: [],
          priceUnit: "month",
          displayOrder: 2,
          priceCurrency: "USD",
        },
        {
          productId: "zai-max",
          productName: "GLM Coding Max",
          description: "old zai max",
          productEquityList: [],
          priceUnit: "month",
          displayOrder: 3,
          priceCurrency: "USD",
        },
      ],
      [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: [
        {
          productId: "bigmodel-lite",
          productName: "GLM Coding Lite",
          description: "旧 BigModel Lite",
          productEquityList: [],
          priceUnit: "month",
          displayOrder: 1,
          priceCurrency: "CNY",
        },
        {
          productId: "bigmodel-pro",
          productName: "GLM Coding Pro",
          description: "旧 BigModel Pro",
          productEquityList: [],
          priceUnit: "month",
          displayOrder: 2,
          priceCurrency: "CNY",
        },
        {
          productId: "bigmodel-max",
          productName: "GLM Coding Max",
          description: "旧 BigModel Max",
          productEquityList: [],
          priceUnit: "month",
          displayOrder: 3,
          priceCurrency: "CNY",
        },
      ],
    }));
    const service = { getStaticProducts } as never;

    const zaiProducts = await loadCodingPlanStaticProductListForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      service,
    );
    const bigmodelProducts = await loadCodingPlanStaticProductListForTest(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      service,
    );

    expect(zaiProducts.map((product) => product.description)).toEqual([
      "old zai lite",
      "old zai pro",
      "old zai max",
    ]);
    expect(bigmodelProducts.map((product) => product.description)).toEqual([
      "旧 BigModel Lite",
      "旧 BigModel Pro",
      "旧 BigModel Max",
    ]);
  });
});

describe("Z.ai Start products", () => {
  it("ignores malformed remote card copy items", () => {
    expect(
      normalizeCodingPlanCardCopyItems([
        null,
        42,
        {},
        { tooltip: "missing text" },
        " valid ",
        { text: " remote ", tooltip: " detail " },
      ]),
    ).toEqual([{ text: "valid" }, { text: "remote", tooltip: "detail" }]);
  });

  it("uses the Z.ai Coding Plan product source when Start Plan upgrades", () => {
    expect(
      resolveCodingPlanUpgradeProductsProviderId(BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan),
    ).toBe(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan);
    expect(
      resolveCodingPlanUpgradeProductsProviderId(
        BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      ),
    ).toBe(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan);
    expect(
      resolveCodingPlanUpgradeProductsProviderId(
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      ),
    ).toBe(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan);
    expect(
      resolveCodingPlanUpgradeProductsProviderId(BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan),
    ).toBe(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan);
  });

  it("prepends the free Start SKUs only when startPlanPreview exists", async () => {
    const getStaticProducts = vi.fn(async () => ({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: [
        {
          productId: "remote-zai-lite-quarter",
          productName: "Remote Lite",
          productEquityList: [],
          priceUnit: "quarter",
          displayOrder: 1,
          priceCurrency: "USD",
          payAmount: 42,
        },
      ],
    }));
    const getStartPlanPreview = vi.fn(async () => ({
      planId: "zai-start-free",
      name: "Z.ai Start",
      entitlements: [
        {
          grantUnits: 1000,
          meter: "tokens",
          period: "day",
          showName: "Start free plan",
          unitType: "tokens",
        },
      ],
    }));
    const service = { getStaticProducts, getStartPlanPreview } as never;

    const products = await loadCodingPlanStaticProductListForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      service,
    );

    expect(products.slice(0, 3).map((product) => product.productId)).toEqual([
      "zai-start-free-monthly",
      "zai-start-free-quarterly",
      "zai-start-free-yearly",
    ]);
    expect(products[3]?.productId).toBe("remote-zai-lite-quarter");
    expect(getStartPlanPreview).toHaveBeenCalledTimes(1);
  });

  it("does not show the free Start SKUs when startPlanPreview is missing", async () => {
    const getStaticProducts = vi.fn(async () => ({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: [
        {
          productId: "remote-zai-lite-quarter",
          productName: "Remote Lite",
          productEquityList: [],
          priceUnit: "quarter",
          displayOrder: 1,
          priceCurrency: "USD",
          payAmount: 42,
        },
      ],
    }));
    const getStartPlanPreview = vi.fn(async () => null);
    const service = { getStaticProducts, getStartPlanPreview } as never;

    const products = await loadCodingPlanStaticProductListForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      service,
    );

    expect(products.map((product) => product.productId)).toEqual(["remote-zai-lite-quarter"]);
  });

  it("removes Start SKUs from the Z.ai Coding Plan purchase list", async () => {
    const batchPreview = vi.fn(async () => ({
      productList: [
        {
          productId: "zai-start-free-monthly",
          productName: "Z.ai Start",
          payAmount: 0,
          priceCurrency: "USD",
        },
        {
          productId: "product-zai-pro-monthly",
          productName: "GLM Coding Pro",
          payAmount: 99,
          priceCurrency: "USD",
        },
      ],
      isSubscribed: false,
      isAuthenticated: true,
    }));
    const service = { batchPreview } as never;

    const snapshot = await loadCodingPlanProductsForTest(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      service,
      false,
    );

    expect(snapshot.productList.map((product) => product.productId)).toEqual([
      "product-zai-pro-monthly",
    ]);
  });
});
