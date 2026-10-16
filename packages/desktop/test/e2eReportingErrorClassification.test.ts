import { describe, expect, it } from "vitest";
import { classifyError } from "./e2e/reporting/e2e-reporting.js";

describe("e2e reporting error classification", () => {
  it("classifies e2e store and workspace fixture failures as infra before assertion patterns", () => {
    expect(
      classifyError("manual compact failed split fixture 注入失败: task-workspace-not-found"),
    ).toBe("infra");
    expect(
      classifyError('renderer task meta 注入失败: {"ok":false,"reason":"store-api-missing"}'),
    ).toBe("infra");
    expect(classifyError("Error: element could not be located by selector")).toBe("infra");
  });

  it("keeps product assertion failures as assertion", () => {
    expect(classifyError("expect(received).toBe(expected)\nExpected: 1\nReceived: 0")).toBe(
      "assertion",
    );
  });

  it("classifies renderer error documents and handle binding failures as infra", () => {
    expect(classifyError("url=chrome-error://chromewebdata/; readyState=complete")).toBe("infra");
    expect(classifyError("webdriver-page-handle-url-mismatch: expected file:// renderer")).toBe(
      "infra",
    );
    expect(classifyError("未找到可切换的工作区 renderer target")).toBe("infra");
  });
});
