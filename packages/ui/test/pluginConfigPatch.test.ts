import { describe, expect, it } from "vitest";
import type { ZCodePluginInfo } from "@zcode/shared";
import { buildPluginConfigPatch } from "../src/settings/pluginConfigPatch.js";

const plugin = {
  id: "demo@marketplace",
  name: "demo",
  enabled: true,
  userConfig: {
    region: { type: "string" },
    endpoint: { type: "string" },
    enabled: { type: "boolean" },
    retries: { type: "number" },
  },
  configuredOptions: {
    region: "us-east-1",
    endpoint: "https://example.test",
    enabled: true,
    retries: 3,
  },
} as ZCodePluginInfo;

describe("plugin config patch", () => {
  it("没有显式 draft 时返回空 patch", () => {
    expect(buildPluginConfigPatch(plugin, {})).toEqual({
      options: {},
      clearOptionKeys: [],
    });
  });

  it("只提交显式修改的 option，不固化其他 effective 值", () => {
    expect(
      buildPluginConfigPatch(plugin, {
        region: "eu-west-1",
      }),
    ).toEqual({
      options: { region: "eu-west-1" },
      clearOptionKeys: [],
    });
  });

  it("保留显式的 false、0 和空字符串值", () => {
    expect(
      buildPluginConfigPatch(plugin, {
        enabled: false,
        retries: 0,
        endpoint: "",
      }),
    ).toEqual({
      options: { enabled: false, endpoint: "", retries: 0 },
      clearOptionKeys: [],
    });
  });

  it("恢复继承时只清除指定 option，不把 effective 值写回", () => {
    expect(
      buildPluginConfigPatch(plugin, {
        region: null,
      }),
    ).toEqual({
      options: {},
      clearOptionKeys: ["region"],
    });
  });
});
