import { expect, it } from "vitest";
import {
  parseRuntimeSubagentConfig,
  subagentProfilesFromSnapshot,
} from "../../src/runtime-subagents/index.js";
import { exampleSubagentConfiguration } from "../../src/runtime-subagents/contract.example.js";
it("保留注入命名空间，Host fallback 不混入磁盘配置", () => {
  expect(parseRuntimeSubagentConfig(exampleSubagentConfiguration).profiles[0]?.name).toBe(
    "tools/review",
  );
  expect(subagentProfilesFromSnapshot({ kind: "built-in-fallback" })).toEqual({
    profiles: [],
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
  });
});
