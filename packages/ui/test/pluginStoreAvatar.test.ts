import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginStoreAvatar } from "../src/settings/PluginStoreAvatar.js";

describe("PluginStoreAvatar", () => {
  it.each([
    ["documents", "documents.png"],
    ["pdf", "pdf.png"],
    ["presentations", "presentations.png"],
    ["spreadsheets", "spreadsheets.png"],
    ["image-search", "image-search.png"],
  ])("uses bundled artwork for the official %s plugin", (name, assetName) => {
    const staleIcon = "https://cdn.example.com/old-document-skills.png";
    const render = (id: string) =>
      renderToStaticMarkup(
        createElement(PluginStoreAvatar, {
          item: { id, name, listing: { icon: staleIcon } },
        }),
      );

    expect(render(`${name}@zcode-plugins-official`)).toContain(assetName);
    expect(render(`${name}@zcode-plugins-official`)).not.toContain(staleIcon);
    expect(render(`${name}@personal`)).toContain(staleIcon);
  });

  it("uses the bundled creator artwork only for the official plugin, including stale listings", () => {
    const icon = "https://cdn.example.com/old-skill-creator.png";
    const render = (id: string) =>
      renderToStaticMarkup(
        createElement(PluginStoreAvatar, {
          item: { id, name: "plugin-creator", listing: { icon } },
        }),
      );
    expect(render("plugin-creator@zcode-plugins-official")).toContain("plugin-creator.png");
    expect(render("plugin-creator@zcode-plugins-official")).not.toContain(icon);
    expect(render("plugin-creator@personal")).toContain(icon);
  });

  it("uses a neutral surface icon when listing icon is missing", () => {
    const html = renderToStaticMarkup(
      createElement(PluginStoreAvatar, {
        item: { name: "example-plugin" },
        className: "size-10",
      }),
    );

    expect(html).toContain("lucide-blocks");
    expect(html).not.toContain("lucide-puzzle");
    expect(html).toContain("rounded-xl");
    expect(html).toContain("bg-surface");
    expect(html).toContain("text-foreground-subtle");
    expect(html).not.toContain("rounded-full");
    expect(html).not.toContain("border-border");
    expect(html).not.toContain("bg-gradient-to-br");
  });

  it("keeps a trusted listing icon ahead of the fallback", () => {
    const html = renderToStaticMarkup(
      createElement(PluginStoreAvatar, {
        item: {
          name: "example-plugin",
          listing: { icon: "https://cdn.example.com/example.png" },
        },
        className: "size-10",
      }),
    );

    expect(html).toContain('src="https://cdn.example.com/example.png"');
    expect(html).toContain("bg-surface");
    expect(html).toContain("h-2/3");
    expect(html).not.toContain("dark:invert");
    expect(html).not.toContain("lucide-blocks");
  });
});
