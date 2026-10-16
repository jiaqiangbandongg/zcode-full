/**
 * ModelCatalogPort 的宿主实现（src/app/model-catalog-port.ts）。
 *
 * 四条被钉住的事实：活视图重读、`current` 标记、默认档位规则、没有档位的模型。
 * 用一个可变的假注册表而不是真 ProviderRegistry：被测的是投影与「什么时候读视图」，
 * 而注册表自己的装配有它自己的用例（packages/provider）。
 */

import { describe, expect, it } from "vitest";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { createModelCatalogPort } from "../src/app/model-catalog-port.js";
import type { ProviderRegistryModelSource } from "../src/app/provider-registry-model-runtime.js";

interface FakeModel {
  modelId: string;
  reasoningLevels: string[];
  contextWindow?: number;
}

interface FakeProvider {
  providerId: string;
  /** 注册表真实的三态：取过名、显式清掉（`null`）、从未取过（缺席）。 */
  providerName?: string | null;
  models: FakeModel[];
}

/**
 * 只实现 `getView()`：被测实现刻意不碰注册表的其余成员（它枚举的是整张视图，不做按 id
 * 的点查）。其余成员抛错，于是「实现偷偷多用了一个入口」会在用例里立刻暴露。
 */
function fakeRegistry(providers: FakeProvider[]): {
  registry: ProviderRegistryModelSource;
  setProviders: (next: FakeProvider[]) => void;
  viewReads: () => number;
} {
  let current = providers;
  let reads = 0;
  const registry = {
    getView() {
      reads += 1;
      return {
        revision: reads,
        providers: current.map((provider) => ({
          providerId: provider.providerId,
          ...(provider.providerName === undefined ? {} : { providerName: provider.providerName }),
          config: {},
          models: provider.models.map((model) => ({
            modelId: model.modelId,
            config: {
              optionSpecs: { reasoningLevel: { values: model.reasoningLevels } },
              properties: { contextWindow: model.contextWindow },
            },
          })),
        })),
      };
    },
    getProvider() {
      throw new Error("the catalog port must not point-query the registry");
    },
    getModel() {
      throw new Error("the catalog port must not point-query the registry");
    },
    validateSelection() {
      throw new Error("the catalog port must not validate selections");
    },
    onDidChange() {
      throw new Error("the catalog port must not subscribe; it re-reads on every call");
    },
  } as unknown as ProviderRegistryModelSource;
  return {
    registry,
    setProviders: (next) => {
      current = next;
    },
    viewReads: () => reads,
  };
}

const ZHIPU: FakeProvider = {
  providerId: "zhipu",
  providerName: "Zhipu",
  models: [
    { modelId: "glm-5.3", reasoningLevels: ["low", "medium", "high"], contextWindow: 200_000 },
    { modelId: "glm-5.3-flash", reasoningLevels: [] },
  ],
};

describe("createModelCatalogPort", () => {
  it("re-reads the live registry view on every call (2026-09-02 stale provider incident)", () => {
    // 判别用例：构造之后注册表才变。一份构造期冻结的目录会让第二次列举给出旧答案，
    // 而 `subagent_model` 的解析正是据它挑模型。
    const fake = fakeRegistry([ZHIPU]);
    const port = createModelCatalogPort({ registry: fake.registry, currentSelection: () => undefined });

    expect(port.listModels().map((entry) => entry.modelId)).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(fake.viewReads()).toBe(1);

    fake.setProviders([
      { providerId: "anthropic", models: [{ modelId: "sonnet", reasoningLevels: [] }] },
    ]);
    expect(port.listModels().map((entry) => `${entry.providerId}/${entry.modelId}`)).toEqual([
      "anthropic/sonnet",
    ]);
    // 每次调用恰好读一次视图：既不缓存，也不为一次列举重复读。
    expect(fake.viewReads()).toBe(2);
  });

  it("flags exactly the entry that matches the session selection, ignoring reasoning options", () => {
    const fake = fakeRegistry([
      ZHIPU,
      { providerId: "anthropic", models: [{ modelId: "glm-5.3", reasoningLevels: [] }] },
    ]);
    // 选择带 reasoning 选项，条目按身份两段匹配（options 不是身份的一部分）。
    const selection: ModelSelection = {
      providerId: "zhipu",
      modelId: "glm-5.3",
      options: { reasoningLevel: "high" },
    };
    const port = createModelCatalogPort({
      registry: fake.registry,
      currentSelection: () => selection,
    });

    const entries = port.listModels();
    expect(entries.filter((entry) => entry.current)).toHaveLength(1);
    expect(entries.find((entry) => entry.current)).toMatchObject({
      providerId: "zhipu",
      modelId: "glm-5.3",
    });
    // 同名模型挂在另一个 provider 下**不**为真：判据是 provider + model，不是裸 id。
    expect(entries.find((entry) => entry.providerId === "anthropic")?.current).toBe(false);
  });

  it("no session selection at all: every entry is current: false", () => {
    const fake = fakeRegistry([ZHIPU]);
    const port = createModelCatalogPort({
      registry: fake.registry,
      currentSelection: () => undefined,
    });
    expect(port.listModels().every((entry) => entry.current === false)).toBe(true);
  });

  it("defaults the reasoning level to the last value (same rule as the GUI picker's toModelOption)", () => {
    const fake = fakeRegistry([ZHIPU]);
    const port = createModelCatalogPort({
      registry: fake.registry,
      currentSelection: () => undefined,
    });
    const [levelled] = port.listModels();
    expect(levelled).toMatchObject({
      providerId: "zhipu",
      modelId: "glm-5.3",
      providerLabel: "Zhipu",
      reasoningLevels: ["low", "medium", "high"],
      defaultReasoningLevel: "high",
      contextWindow: 200_000,
    });
  });

  it("a model with no reasoning levels gets an empty array and no default", () => {
    // 空数组而不是缺席（端口契约），而默认档位整个键不出——一个 `defaultReasoningLevel:
    // undefined` 读起来像「有默认但没算出来」。
    const fake = fakeRegistry([ZHIPU]);
    const port = createModelCatalogPort({
      registry: fake.registry,
      currentSelection: () => undefined,
    });
    const flash = port.listModels().find((entry) => entry.modelId === "glm-5.3-flash")!;
    expect(flash.reasoningLevels).toEqual([]);
    expect("defaultReasoningLevel" in flash).toBe(false);
    expect("contextWindow" in flash).toBe(false);
  });

  it("a provider with no display name leaves providerLabel absent, and no entry is ever disabled", () => {
    const fake = fakeRegistry([
      { providerId: "anonymous", models: [{ modelId: "m", reasoningLevels: [] }] },
    ]);
    const port = createModelCatalogPort({
      registry: fake.registry,
      currentSelection: () => undefined,
    });
    const [entry] = port.listModels();
    expect("providerLabel" in entry!).toBe(false);
    // 本宿主没有「配了但不可用」的来源（见实现里的注释）：字段恒缺席，绝不兜一个空串。
    expect("disabledReason" in entry!).toBe(false);
  });

  it("null and blank provider names collapse to an absent key, never a printed empty label", () => {
    // 注册表的 providerName 是 `string | null | undefined`（config-service.ts 把空串归一成
    // null），端口契约只认 `string | undefined`。三种「没名字」必须给出同一个答案——放一个
    // null 或空串过去，它会原样印进 ListModels 的那一行。
    const fake = fakeRegistry([
      {
        providerId: "cleared",
        providerName: null,
        models: [{ modelId: "m", reasoningLevels: [] }],
      },
      { providerId: "blank", providerName: "   ", models: [{ modelId: "m", reasoningLevels: [] }] },
      {
        providerId: "named",
        providerName: "  Zhipu  ",
        models: [{ modelId: "m", reasoningLevels: [] }],
      },
    ]);
    const port = createModelCatalogPort({
      registry: fake.registry,
      currentSelection: () => undefined,
    });
    const [cleared, blank, named] = port.listModels();
    expect("providerLabel" in cleared!).toBe(false);
    expect("providerLabel" in blank!).toBe(false);
    // 取过名字的照常在场，且顺手去掉两端空白（读侧拿到的就是要显示的那个词）。
    expect(named!.providerLabel).toBe("Zhipu");
  });

  it("copies the reasoning level array so the caller cannot mutate the registry's view", () => {
    const levels = ["low", "high"];
    const fake = fakeRegistry([
      { providerId: "p", models: [{ modelId: "m", reasoningLevels: levels }] },
    ]);
    const port = createModelCatalogPort({
      registry: fake.registry,
      currentSelection: () => undefined,
    });
    port.listModels()[0]!.reasoningLevels.push("mutated");
    expect(levels).toEqual(["low", "high"]);
  });
});
