import { expect, it } from "vitest";
import { pluginUiStateKey } from "@/plugin-ui/adapters/pluginUiStateKey.js";
it("下发稳定的不透明窗口键，不暴露路径或 session", async () => {
  const key = '["/Users/dev/private","session-private","panel"]';
  const result = await pluginUiStateKey(key);
  expect(result).toMatch(/^[a-f0-9]{64}$/);
  expect(result).toBe(await pluginUiStateKey(key));
  expect(result).not.toBe(await pluginUiStateKey(key + "other"));
  expect(result).not.toContain("private");
});
