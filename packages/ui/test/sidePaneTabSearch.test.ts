import { describe, expect, it } from "vitest";
import {
  buildSearchFields,
  filterAndRankSearchItems,
  normalizeSearchQuery,
} from "../src/app-shell/sidePaneTabSearch.js";

describe("sidePaneTabSearch", () => {
  function item(id: string, title: string, hint: string, typeLabel: string) {
    return {
      id,
      searchFields: buildSearchFields(title, hint, typeLabel),
    };
  }

  it("matches every query token across title, path, and type", () => {
    const items = [
      item("docx", "Knowledge Atlas.docx", "/Users/demo/Downloads", "Code Viewer"),
      item("browser", "Nimbus", "https://nimbus.example", "Browser"),
    ];

    expect(
      filterAndRankSearchItems(items, normalizeSearchQuery("atlas downloads")).map(
        (result) => result.id,
      ),
    ).toEqual(["docx"]);
  });

  it("ranks title matches before path and type matches", () => {
    const items = [
      item("path", "Downloads note", "/Users/demo/nimbus.md", "Code Viewer"),
      item("title", "Nimbus", "https://example.com", "Browser"),
      item("type", "Example", "https://example.com", "Nimbus Viewer"),
    ];

    expect(
      filterAndRankSearchItems(items, normalizeSearchQuery("nimbus")).map(
        (result) => result.id,
      ),
    ).toEqual(["title", "path", "type"]);
  });
});
