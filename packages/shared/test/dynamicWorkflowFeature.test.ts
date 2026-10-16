import { describe, expect, it } from "vitest";
import {
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  isDynamicWorkflowModeEnabled,
  isDynamicWorkflowOffered,
  normalizeDynamicWorkflowMode,
  resolveDynamicWorkflowClientConfig,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
} from "../src/dynamic-workflow-feature.js";

// DWG-01（docs/dynamic-workflow/launch.md「Gray release: the `dynamicWorkflow` feature key」）：
// 远端取值、缺省 fail-closed、本地覆盖优先级三件事都由这个纯函数裁决，三端共用。

function remote(mode: unknown) {
  return { mode };
}

describe("resolveDynamicWorkflowClientConfig（DWG-01）", () => {
  it("远端合法取值原样生效，onDemand 与 alwaysOn 同为开启", () => {
    expect(resolveDynamicWorkflowClientConfig({ remote: remote("alwaysOn") })).toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "remote",
      offeredMode: "alwaysOn",
    });
    expect(resolveDynamicWorkflowClientConfig({ remote: remote("onDemand") })).toEqual({
      mode: "onDemand",
      enabled: true,
      source: "remote",
      offeredMode: "onDemand",
    });
    expect(resolveDynamicWorkflowClientConfig({ remote: remote("disabled") })).toEqual({
      mode: "disabled",
      enabled: false,
      source: "remote",
      offeredMode: "disabled",
    });
  });

  it.each([
    ["key 缺失", undefined],
    ["显式 null", null],
    ["非法枚举", remote("bogus")],
    ["mode 不是字符串", remote(1)],
    ["对象里没有 mode", {}],
    ["远端下发字符串而非对象", "alwaysOn"],
  ])("远端 %s 时 fail-closed 到 default", (_name, value) => {
    expect(resolveDynamicWorkflowClientConfig({ remote: value })).toEqual({
      mode: DEFAULT_DYNAMIC_WORKFLOW_MODE,
      enabled: false,
      source: "default",
      offeredMode: DEFAULT_DYNAMIC_WORKFLOW_MODE,
    });
  });

  it("本地覆盖优先于远端（含把远端的开关掉）", () => {
    expect(
      resolveDynamicWorkflowClientConfig({
        remote: remote("disabled"),
        env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "alwaysOn" },
      }),
    ).toEqual({ mode: "alwaysOn", enabled: true, source: "override", offeredMode: "alwaysOn" });
    expect(
      resolveDynamicWorkflowClientConfig({
        remote: remote("alwaysOn"),
        env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "disabled" },
      }),
    ).toEqual({ mode: "disabled", enabled: false, source: "override", offeredMode: "disabled" });
  });

  it("非法或空覆盖被忽略，继续按远端裁决", () => {
    expect(
      resolveDynamicWorkflowClientConfig({
        remote: remote("alwaysOn"),
        env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "yes" },
      }),
    ).toEqual({ mode: "alwaysOn", enabled: true, source: "remote", offeredMode: "alwaysOn" });
    expect(
      resolveDynamicWorkflowClientConfig({
        remote: undefined,
        env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "" },
      }).source,
    ).toBe("default");
  });

  it("覆盖值允许首尾空白（shell 传参常见）", () => {
    expect(
      resolveDynamicWorkflowClientConfig({
        remote: undefined,
        env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: " alwaysOn " },
      }),
    ).toEqual({ mode: "alwaysOn", enabled: true, source: "override", offeredMode: "alwaysOn" });
  });
});

describe("normalizeDynamicWorkflowMode / isDynamicWorkflowModeEnabled", () => {
  it("只认三个取值，其余一律 undefined", () => {
    expect(normalizeDynamicWorkflowMode("disabled")).toBe("disabled");
    expect(normalizeDynamicWorkflowMode("onDemand")).toBe("onDemand");
    expect(normalizeDynamicWorkflowMode("alwaysOn")).toBe("alwaysOn");
    expect(normalizeDynamicWorkflowMode("AlwaysOn")).toBeUndefined();
    expect(normalizeDynamicWorkflowMode(undefined)).toBeUndefined();
    expect(normalizeDynamicWorkflowMode(true)).toBeUndefined();
  });

  it("本版本两个开启态折叠成同一个布尔", () => {
    expect(isDynamicWorkflowModeEnabled("disabled")).toBe(false);
    expect(isDynamicWorkflowModeEnabled("onDemand")).toBe(true);
    expect(isDynamicWorkflowModeEnabled("alwaysOn")).toBe(true);
  });
});

// DWG-18（launch.md「The user's choice」）：服务端给出可用性与默认值，用户只能在已提供的范围里选。
describe("applyDynamicWorkflowUserMode（DWG-18）", () => {
  const offer = (mode: "disabled" | "onDemand" | "alwaysOn") =>
    createDynamicWorkflowClientConfig(mode, "remote");

  it("功能已提供时，用户选择取代提供的模式，默认值仍记在 offeredMode", () => {
    expect(applyDynamicWorkflowUserMode(offer("onDemand"), "alwaysOn")).toEqual({
      mode: "alwaysOn",
      enabled: true,
      source: "remote",
      offeredMode: "onDemand",
      userMode: "alwaysOn",
    });
    expect(applyDynamicWorkflowUserMode(offer("alwaysOn"), "disabled")).toEqual({
      mode: "disabled",
      enabled: false,
      source: "remote",
      offeredMode: "alwaysOn",
      userMode: "disabled",
    });
  });

  it("提供的是 disabled 时用户选择不生效，也不记 userMode", () => {
    expect(applyDynamicWorkflowUserMode(offer("disabled"), "alwaysOn")).toEqual({
      mode: "disabled",
      enabled: false,
      source: "remote",
      offeredMode: "disabled",
    });
  });

  it.each([[undefined], [null], [""], ["bogus"], [1]])(
    "没有选择或存了非法值（%s）时原样沿用提供的模式",
    (choice) => {
      expect(applyDynamicWorkflowUserMode(offer("onDemand"), choice)).toEqual(offer("onDemand"));
    },
  );

  it("只看 offeredMode 重新推导：对已应用过选择的快照再应用是幂等覆盖", () => {
    const applied = applyDynamicWorkflowUserMode(offer("alwaysOn"), "disabled");
    expect(applyDynamicWorkflowUserMode(applied, undefined)).toEqual(offer("alwaysOn"));
    expect(applyDynamicWorkflowUserMode(applied, "onDemand").mode).toBe("onDemand");
  });

  it("resolveDynamicWorkflowClientConfig 接收 userMode，覆盖值仍只决定提供的模式", () => {
    expect(
      resolveDynamicWorkflowClientConfig({
        remote: remote("alwaysOn"),
        env: { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "onDemand" },
        userMode: "disabled",
      }),
    ).toEqual({
      mode: "disabled",
      enabled: false,
      source: "override",
      offeredMode: "onDemand",
      userMode: "disabled",
    });
  });

  it("isDynamicWorkflowOffered 只看提供的模式，不看用户选择", () => {
    expect(
      isDynamicWorkflowOffered(applyDynamicWorkflowUserMode(offer("alwaysOn"), "disabled")),
    ).toBe(true);
    expect(isDynamicWorkflowOffered(offer("disabled"))).toBe(false);
  });

  it("isDynamicWorkflowOffered：没有 offeredMode 的快照（旧 Host）或读不懂的值按未提供", () => {
    // 新 UI（例如手机远控 bundle）连旧 Host 时，快照只有生效的 mode / enabled，没有 offeredMode；
    // 旧 Host 不认用户选择，所以不能把设置行摆出来。
    const legacy = { mode: "alwaysOn", enabled: true, source: "remote" } as unknown as Parameters<
      typeof isDynamicWorkflowOffered
    >[0];
    expect(isDynamicWorkflowOffered(legacy)).toBe(false);
    expect(
      isDynamicWorkflowOffered({
        ...offer("alwaysOn"),
        offeredMode: "sometimes",
      } as unknown as Parameters<typeof isDynamicWorkflowOffered>[0]),
    ).toBe(false);
  });
});
