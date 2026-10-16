// @vitest-environment jsdom

import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { AddMarketplaceSourceDialog } from "@/settings/AddMarketplaceSourceDialog.js";
import {
  PluginStoreSourceRefreshFailure,
  PluginStoreSourcesDialog,
} from "@/settings/PluginStoreSourcesDialog.js";

afterEach(() => {
  cleanup();
});

describe("PluginStoreSourcesDialog", () => {
  it("uses the shared dialog typography and large action sizes", () => {
    const addSource = readFileSync(
      "packages/ui/src/settings/AddMarketplaceSourceDialog.tsx",
      "utf8",
    );
    const sources = readFileSync("packages/ui/src/settings/PluginStoreSourcesDialog.tsx", "utf8");
    const page = readFileSync("packages/ui/src/settings/PluginStorePage.tsx", "utf8");

    expect(addSource).toContain('DialogTitle className="text-ui-lg font-medium text-foreground"');
    expect(addSource).toContain('className="text-ui-base text-foreground-subtle"');
    expect(addSource).toContain("min-w-0 overflow-y-auto");
    expect(addSource).toContain("whitespace-pre-wrap break-words");
    expect(addSource.match(/size="lg"/g)).toHaveLength(3);
    expect(addSource).not.toContain('className="h-9 rounded-lg"');
    expect(sources).toContain('DialogTitle className="text-ui-lg font-medium text-foreground"');
    expect(sources).toContain("text-ui-base text-foreground-subtle");
    expect(sources).toContain("text-ui-base text-destructive");
    expect(sources.match(/size="icon-lg"/g)).toHaveLength(2);
    expect(page).toContain("error && !addSourceOpen");
    expect(page).toContain("onAddMarketplace={handleAddMarketplace}");
    expect(page).toContain("error={addMarketplaceError}");
  });

  it("shows the persisted marketplace refresh failure beside its source", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(PluginStoreSourceRefreshFailure, {
          failure: {
            code: "plugin_archive_fetch_failed",
            failedAt: "2026-08-06T03:55:00.000Z",
            message: "Archive download timed out",
          },
        }),
      ),
    );

    expect(html).toContain("Archive download timed out");
    expect(html).toContain("Refresh failed");
  });

  // claude-plugins-official 的刷新失败不提示（任何原因）；其它来源仍显示失败行。
  it("hides the refresh failure of claude-plugins-official but keeps it for other sources", () => {
    const failure = {
      code: "plugin_marketplace_invalid",
      failedAt: "2026-08-06T03:55:00.000Z",
      message: "git clone failed",
    };
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(PluginStoreSourcesDialog, {
          open: true,
          onOpenChange: () => {},
          marketplaces: [
            {
              id: "claude-plugins-official",
              name: "claude-plugins-official",
              source: {},
              pluginCount: 0,
              refreshFailure: failure,
            },
            {
              id: "zcode-labs",
              name: "zcode-labs",
              source: {},
              pluginCount: 0,
              refreshFailure: failure,
            },
          ],
          onUpdateMarketplace: () => {},
          onRemoveMarketplace: () => {},
          operationId: null,
        }),
      ),
    );

    const failures = screen.getAllByTestId("plugin-store-source-refresh-failure");
    expect(failures).toHaveLength(1);
    expect(
      failures[0]!
        .closest("[data-testid='plugin-store-source-row']")
        ?.getAttribute("data-marketplace-id"),
    ).toBe("zcode-labs");
  });

  it("renders an add failure inside the add marketplace dialog", () => {
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(AddMarketplaceSourceDialog, {
          open: true,
          onOpenChange: () => {},
          onAddMarketplace: async () => false,
          operationId: null,
          error: "Invalid marketplace source",
        }),
      ),
    );

    expect(screen.getByTestId("plugin-store-add-source-dialog")).toBeTruthy();
    expect(screen.getByTestId("plugin-store-add-source-error").textContent).toContain(
      "Invalid marketplace source",
    );
  });

  it("renders official sources first and custom sources by lastUpdated", () => {
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(PluginStoreSourcesDialog, {
          open: true,
          onOpenChange: () => {},
          marketplaces: [
            {
              id: "never-refreshed",
              name: "Never Refreshed",
              source: {},
              pluginCount: 0,
            },
            {
              id: "zcode-plugins-test",
              name: "zcode-plugins-test",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-08-20T12:00:00Z",
            },
            {
              id: "claude-plugins-official",
              name: "claude-plugins-official",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-01-01T00:00:00Z",
            },
            {
              id: "zcode-plugins-official",
              name: "zcode-plugins-official",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-08-20T23:00:00Z",
            },
            {
              id: "zcode-labs",
              name: "zcode-labs",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-08-20T12:00:00Z",
            },
          ],
          onUpdateMarketplace: () => {},
          onRemoveMarketplace: () => {},
          operationId: null,
        }),
      ),
    );

    expect(
      screen
        .getAllByTestId("plugin-store-source-row")
        .map((row) => row.getAttribute("data-marketplace-id")),
    ).toEqual([
      "zcode-plugins-official",
      "claude-plugins-official",
      "zcode-labs",
      "zcode-plugins-test",
      "never-refreshed",
    ]);
  });
});
