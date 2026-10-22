import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "#office/profile.ts";

// Single-format plugins: wording names only what each one opens.
const as = (profile: Profile) => {
  vi.resetModules();
  vi.doMock("#office/profile.ts", () => ({ PROFILE: profile }));
};

describe("a PDF-only profile", () => {
  beforeEach(() =>
    as({ name: "pdf", version: "0.2.0", title: { en: "PDF", "zh-CN": "PDF" }, kinds: ["pdf"] }),
  );

  it("addresses the plugin's own server and resources", async () => {
    const contract = await import("#office/contract.ts");
    expect(contract.SERVER_NAME).toBe("pdf");
    expect(contract.PANEL_URI).toBe("ui://pdf/panel.html");
    expect(contract.kindOf("paper.pdf")).toBe("pdf");
    expect(contract.kindOf("report.docx")).toBeNull();
  });
});
