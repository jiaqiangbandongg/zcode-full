import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusDot } from "@/settings/StatusDot.js";

describe("StatusDot", () => {
  it("uses the secondary foreground token for subtle status", () => {
    const html = renderToStaticMarkup(createElement(StatusDot, { tone: "subtle" }));

    expect(html).toContain("text-foreground-subtle");
    expect(html).not.toContain("text-muted-foreground");
  });
});
