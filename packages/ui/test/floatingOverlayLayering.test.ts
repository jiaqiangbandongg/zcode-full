import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const componentSources = await Promise.all(
  ["popover.tsx", "select.tsx", "dropdown-menu.tsx", "context-menu.tsx"].map(
    async (fileName) => ({
      fileName,
      source: await readFile(
        new URL(`../src/components/ui/${fileName}`, import.meta.url),
        "utf8",
      ),
    }),
  ),
);

const tooltipSource = await readFile(
  new URL("../src/components/ui/tooltip.tsx", import.meta.url),
  "utf8",
);

describe("floating overlay layering", () => {
  it("可操作浮层统一位于辅助 tooltip 之上", () => {
    expect(tooltipSource).toContain('"z-50 inline-flex');

    for (const { fileName, source } of componentSources) {
      expect(source, fileName).toContain("z-[60]");
      expect(source, fileName).not.toContain('"z-50');
    }
  });

  it("Dropdown 获得焦点时仍持续显示默认阴影", () => {
    const dropdownSource =
      componentSources.find(({ fileName }) => fileName === "dropdown-menu.tsx")
        ?.source ?? "";

    expect(dropdownSource).toContain(
      "!shadow-md focus:!shadow-md focus-visible:!shadow-md",
    );
    expect(dropdownSource).not.toContain(
      "text-foreground shadow-md duration-100",
    );
  });
});
