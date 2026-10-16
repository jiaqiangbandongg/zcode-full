import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";

describe("SettingsFormTextarea", () => {
  it("renders the textarea itself as the styled input surface", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsFormTextarea, {
        "aria-label": "Configuration",
        className: "font-mono",
      }),
    );

    expect(html).toMatch(/^<textarea /);
    expect(html).not.toContain("<div");
    expect(html).toContain("rounded-lg");
    expect(html).toContain("border-input-border");
    expect(html).toContain("bg-input");
    expect(html).toContain("focus-visible:border-input-border-focused");
    expect(html).toContain("focus-visible:bg-input-focused");
  });
});
