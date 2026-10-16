import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const cases = [
  [
    "dropdown-menu",
    ["DropdownMenuContent", "DropdownMenuSubContent"],
    [
      "DropdownMenuItem",
      "DropdownMenuCheckboxItem",
      "DropdownMenuRadioItem",
      "DropdownMenuSubTrigger",
    ],
  ],
  [
    "context-menu",
    ["ContextMenuContent", "ContextMenuSubContent"],
    ["ContextMenuItem", "ContextMenuSubTrigger"],
  ],
  ["select", ["SelectContent"], ["SelectItem", "SelectRichItem"]],
] as const;

describe("menu radius hierarchy", () => {
  for (const [file, shells, items] of cases) {
    it(`${file}: independent shells use lg and options use md`, async () => {
      const source = await readFile(
        new URL(`../src/components/ui/${file}.tsx`, import.meta.url),
        "utf8",
      );
      for (const [names, radius] of [
        [shells, "lg"],
        [items, "md"],
      ] as const) {
        for (const name of names) {
          const start = source.search(new RegExp(`(?:function ${name}\\(|const ${name} =)`));
          expect(start).toBeGreaterThanOrEqual(0);
          // 组件体截到下一个顶层声明：forwardRef 组件是 `const X =`，只认 function 会把相邻组件并进来。
          const boundaries = ["\nfunction ", "\nconst "]
            .map((marker) => source.indexOf(marker, start + 1))
            .filter((index) => index >= 0);
          const next = boundaries.length > 0 ? Math.min(...boundaries) : -1;
          const body = source.slice(start, next < 0 ? undefined : next);
          expect(body.match(/\brounded-(?:sm|md|lg|xl|2xl|3xl|full)\b/g), name).toEqual([
            `rounded-${radius}`,
          ]);
        }
      }
    });
  }
});

describe("business menus inherit shared radius", () => {
  for (const file of [
    "WindowsCaptionMenuButton",
    "settings/OffPeakEditActionsMenu",
    "settings/AutomationEditView",
    "settings/OffPeakHistoryTab",
  ]) {
    it(file, async () => {
      const source = await readFile(new URL(`../src/${file}.tsx`, import.meta.url), "utf8");
      const tags = source.match(/<DropdownMenu(?:Content|Item)\b[\s\S]*?(?=\n\s*>|>\n)/g) ?? [];
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag).not.toMatch(/rounded-(?:lg|xl|2xl|3xl|\[)/);
      }
    });
  }
});
