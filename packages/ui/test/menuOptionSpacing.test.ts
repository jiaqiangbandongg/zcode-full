import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dropdownMenuSource = readFileSync(
  new URL("../src/components/ui/dropdown-menu.tsx", import.meta.url),
  "utf8",
);
const contextMenuSource = readFileSync(
  new URL("../src/components/ui/context-menu.tsx", import.meta.url),
  "utf8",
);
const selectSource = readFileSync(
  new URL("../src/components/ui/select.tsx", import.meta.url),
  "utf8",
);

describe("shared menu option spacing", () => {
  it("keeps dropdown menu roots, submenus, and groups 2px apart", () => {
    expect(dropdownMenuSource.match(/flex flex-col gap-0\.5/g)).toHaveLength(4);
  });

  it("keeps context menu roots and submenus 2px apart", () => {
    expect(contextMenuSource.match(/flex flex-col gap-0\.5/g)).toHaveLength(2);
  });

  it("keeps select viewports and groups 2px apart", () => {
    expect(selectSource.match(/flex flex-col gap-0\.5/g)).toHaveLength(2);
  });
});
