import { describe, expect, it } from "vitest";
import { ALL_KINDS } from "#office/contract.ts";
import { OFFICE_RUNTIME_OUTPUTS } from "./contract.ts";
import { examplePdfPlugin } from "./contract.example.ts";
import { officeRuntimeModule } from "./module.ts";

// 契约测试只 import contract 与 module，不知道实现是谁。
describe("office-runtime contract", () => {
  it("declares its module manifest", () => {
    expect(officeRuntimeModule.id).toBe("office-runtime");
  });

  it("guarantees the server and panel entry points the built-in plugins depend on", () => {
    expect(OFFICE_RUNTIME_OUTPUTS).toEqual([
      "dist/server.mjs",
      "dist/ui/assets.json",
      "dist/ui/panel.html",
    ]);
  });

  it("only accepts formats the runtime can open", () => {
    const { config } = examplePdfPlugin();
    expect(config.kinds.every((kind) => ALL_KINDS.includes(kind))).toBe(true);
  });
});
