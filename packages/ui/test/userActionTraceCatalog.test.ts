import { describe, expect, it } from "vitest";
import { USER_ACTION_CATALOG } from "../src/lib/userActionTraceCatalog.js";

describe("user action trace catalog", () => {
  it("feature/action 组合唯一且不使用动态标识", () => {
    const keys = USER_ACTION_CATALOG.map((entry) => `${entry.featureId}:${entry.action}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of USER_ACTION_CATALOG) {
      expect(entry.featureId).toMatch(/^[a-z]+(?:[._][a-z]+)+$/u);
      expect(entry.action).toMatch(/^[a-z]+(?:_[a-z]+)*$/u);
      expect(entry.featureId).not.toMatch(/taskId|workspacePath|pluginId/iu);
    }
  });

  it("不声明 /event/report sink", () => {
    for (const entry of USER_ACTION_CATALOG) {
      expect(entry).not.toHaveProperty("eventPolicy");
      expect(entry).not.toHaveProperty("elementName");
    }
  });
});
