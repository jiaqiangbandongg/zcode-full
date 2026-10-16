import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IMcpSyncService } from "@zcode/services";
import {
  buildRemoteMcpSyncRows,
  buildRemoteMcpSyncImportParams,
  filterRemoteMcpSyncRows,
  RemoteMcpSyncDialog,
  RemoteMcpSyncSelectionList,
  RemoteMcpSyncTargetRow,
  resolveDefaultRemoteMcpSyncSelection,
} from "../src/settings/RemoteMcpSyncDialog.js";

const controlHintTooltipMockState = vi.hoisted(() => ({
  latest: null as null | {
    hasOnMouseEnter: boolean;
    hasOnMouseLeave: boolean;
    open: boolean | undefined;
    tabIndex: unknown;
  },
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({
    children,
    description,
    open,
    title,
  }: {
    children: unknown;
    description?: string;
    open?: boolean;
    title: string;
  }) => {
    const triggerProps = isValidElement<{
      onMouseEnter?: unknown;
      onMouseLeave?: unknown;
      tabIndex?: unknown;
    }>(children)
      ? children.props
      : {};
    controlHintTooltipMockState.latest = {
      hasOnMouseEnter: typeof triggerProps.onMouseEnter === "function",
      hasOnMouseLeave: typeof triggerProps.onMouseLeave === "function",
      open,
      tabIndex: triggerProps.tabIndex,
    };

    return createElement(
      "span",
      {
        "data-tooltip-open": String(open),
        "data-tooltip-description": description,
        "data-tooltip-title": title,
      },
      children,
    );
  },
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ open, children }: { open: boolean; children: unknown }) =>
    open ? createElement("div", { "data-dialog-open": true }, children) : null,
  DialogContent: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("div", props, children),
  DialogHeader: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("div", props, children),
  DialogTitle: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("h2", props, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (
        { id }: { id: string },
        values?: Record<string, string | number>,
      ) => {
        const messages: Record<string, string> = {
          "settings.mcp.remoteSync.title": "Sync MCP servers to remote target",
          "settings.mcp.remoteSync.warningTitle": "MCP data and environment availability",
          "settings.mcp.remoteSync.warningDescription":
            "Sync copies local user MCP server configuration to the remote host. HTTP MCP URLs are copied, and filesystem MCP paths are rewritten for the selected remote workspace, but not all dependent data and system environment capabilities can be guaranteed. If an MCP server is unavailable because of the remote environment, permissions, or missing dependencies, install it or add the dependencies on the remote server.",
          "settings.mcp.remoteSync.target": `Target: ${values?.target ?? ""}`,
          "settings.mcp.remoteSync.loading": "Loading local MCP servers...",
          "settings.mcp.remoteSync.empty": "No local user MCP servers found.",
          "settings.mcp.remoteSync.filteredEmpty":
            "All local user MCP servers already exist on the remote host.",
          "settings.mcp.remoteSync.showExisting": "Show existing remote MCP servers",
          "settings.mcp.remoteSync.selectAll": "Select all",
          "settings.mcp.remoteSync.start": "Sync selected",
          "settings.mcp.remoteSync.syncing": "Syncing MCP servers...",
          "settings.mcp.remoteSync.existing": "Already exists on remote",
          "settings.mcp.remoteSync.synced": "Synced",
          "settings.mcp.remoteSync.skipped": "Skipped",
          "settings.mcp.remoteSync.failed": "Failed",
          "settings.mcp.remoteSync.resultEmpty": "No MCP sync results were returned.",
          "settings.mcp.remoteSync.selectionCount": `${values?.selected ?? 0}/${values?.total ?? 0} selected`,
          "settings.mcp.remoteSync.noSelection": "Select at least one missing MCP server.",
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

function createMcpSyncServiceStub(): IMcpSyncService {
  return {
    loadMcpFromUserDirectory: vi.fn(async () => ({ servers: [] })),
    saveMcpToUserDirectory: vi.fn(async () => undefined),
    listLocalUserMcpCandidates: vi.fn(async () => ({
      localHomeDir: "/Users/me",
      candidates: [],
    })),
    listRemoteUserMcpStatuses: vi.fn(async () => ({ statuses: [] })),
    exportMcpServers: vi.fn(async () => ({
      localHomeDir: "/Users/me",
      servers: [],
    })),
    checkRemoteUserMcpWriteAccess: vi.fn(async () => ({
      ok: true,
      path: "/home/dev/.zcode/cli",
    })),
    importMcpServers: vi.fn(async () => ({ results: [] })),
  };
}

describe("RemoteMcpSyncDialog helpers", () => {
  it("builds import params with local and remote workspace paths", () => {
    expect(
      buildRemoteMcpSyncImportParams({
        exported: {
          localHomeDir: "/Users/alice",
          servers: [
            {
              id: "filesystem-id",
              name: "filesystem",
              config: { type: "stdio", command: "npx" },
              enabled: true,
              source: "zcode",
              path: "/Users/alice/.zcode/cli/config.json",
            },
          ],
        },
        localHomeDir: "/Users/fallback",
        localWorkspacePath: "/Users/alice/project",
        remoteWorkspacePath: "/srv/project",
      }),
    ).toMatchObject({
      localHomeDir: "/Users/alice",
      localWorkspacePath: "/Users/alice/project",
      remoteWorkspacePath: "/srv/project",
      overwrite: false,
    });
  });

  it("marks existing remote MCP servers and selects only missing servers", () => {
    const rows = buildRemoteMcpSyncRows(
      [
        {
          id: "context7-id",
          name: "context7",
          config: { type: "stdio", command: "npx" },
          enabled: true,
          source: "zcode",
          path: "/Users/me/.zcode/cli/config.json",
        },
        {
          id: "docs-id",
          name: "docs",
          config: { type: "http", url: "https://mcp.example.com/mcp" },
          enabled: true,
          source: "zcode",
          path: "/Users/me/.zcode/cli/config.json",
        },
      ],
      [{ name: "docs", exists: true }],
    );

    expect(rows.map((row) => ({ id: row.candidate.id, exists: row.exists }))).toEqual([
      { id: "context7-id", exists: false },
      { id: "docs-id", exists: true },
    ]);
    expect(Array.from(resolveDefaultRemoteMcpSyncSelection(rows))).toEqual([
      "context7-id",
    ]);
  });

  it("filters remote existing MCP rows when the existing filter is disabled", () => {
    const rows = buildRemoteMcpSyncRows(
      [
        {
          id: "missing-id",
          name: "filesystem",
          config: { type: "stdio", command: "npx" },
          enabled: true,
          source: "agents",
          path: "/Users/me/.agents/mcp.json",
        },
        {
          id: "existing-id",
          name: "docs",
          config: { type: "http", url: "https://mcp.example.com/mcp" },
          enabled: true,
          source: "agents",
          path: "/Users/me/.agents/mcp.json",
        },
      ],
      [{ name: "docs", exists: true }],
    );

    expect(filterRemoteMcpSyncRows(rows, true).map((row) => row.candidate.id)).toEqual([
      "missing-id",
      "existing-id",
    ]);
    expect(filterRemoteMcpSyncRows(rows, false).map((row) => row.candidate.id)).toEqual([
      "missing-id",
    ]);
  });
});

describe("RemoteMcpSyncDialog", () => {
  it("renders a warning tooltip next to the sync title", () => {
    const service = createMcpSyncServiceStub();
    controlHintTooltipMockState.latest = null;

    const html = renderToStaticMarkup(
      createElement(RemoteMcpSyncDialog, {
        open: true,
        onOpenChange: () => undefined,
        localMcpSyncService: service,
        remoteMcpSyncService: service,
        remoteTarget: {
          kind: "ssh",
          host: "dev.example.com",
          username: "alice",
          port: 22,
        },
        workspacePath: "/home/alice/project",
        onSynced: async () => undefined,
      }),
    );

    expect(html).toContain("Sync MCP servers to remote target");
    expect(html).toContain('data-tooltip-title="MCP data and environment availability"');
    expect(html).toContain("HTTP MCP URLs are copied");
    expect(html).toContain("filesystem MCP paths are rewritten");
    expect(html).toContain("not all dependent data and system environment capabilities");
    expect(html).toContain("install it or add the dependencies on the remote server");
    expect(html).not.toContain("secret");
    expect(html).toContain('aria-label="MCP data and environment availability"');
    expect(controlHintTooltipMockState.latest).toEqual({
      hasOnMouseEnter: true,
      hasOnMouseLeave: true,
      open: false,
      tabIndex: undefined,
    });
  });

  it("keeps the dialog size stable while the MCP list scrolls", () => {
    const service = createMcpSyncServiceStub();

    const html = renderToStaticMarkup(
      createElement(RemoteMcpSyncDialog, {
        open: true,
        onOpenChange: () => undefined,
        localMcpSyncService: service,
        remoteMcpSyncService: service,
        remoteTarget: {
          kind: "ssh",
          host: "dev.example.com",
          username: "alice",
          port: 22,
        },
        workspacePath: "/home/alice/project",
        onSynced: async () => undefined,
      }),
    );

    const dialogContentClass =
      html.match(/<div class="([^"]*max-h-\[min\(720px,calc\(100dvh-2rem\)\)\][^"]*)"/u)?.[1] ??
      "";
    expect(dialogContentClass.split(/\s+/u)).toEqual(
      expect.arrayContaining([
        "h-[min(720px,calc(100dvh-2rem))]",
        "flex",
        "flex-col",
        "overflow-hidden",
      ]),
    );
    expect(html).toContain("min-h-0 flex-1 overflow-y-auto");
  });

  it("renders MCP selection rows as card-style items like Skills", () => {
    const rows = buildRemoteMcpSyncRows(
      [
        {
          id: "filesystem-id",
          name: "filesystem",
          config: { type: "stdio", command: "npx" },
          enabled: true,
          source: "zcode",
          path: "/Users/me/.zcode/cli/config.json",
        },
      ],
      [],
    );

    const html = renderToStaticMarkup(
      createElement(RemoteMcpSyncSelectionList, {
        rows,
        selectedIds: new Set(["filesystem-id"]),
        onToggle: () => undefined,
      }),
    );

    expect(html).toContain("grid gap-2");
    expect(html).toContain("rounded-lg border border-border bg-surface");
    expect(html).toContain('aria-labelledby="remote-mcp-sync-filesystem-id-label"');
    expect(html).toContain("/Users/me/.zcode/cli/config.json");
    expect(html).not.toContain("divide-y divide-border");
  });

  it("places the existing filter on the same row as the target", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteMcpSyncTargetRow, {
        targetLabel: "alice@dev.example.com:22 · /home/alice/project",
        showExistingRemoteMcp: true,
        showExistingFilter: true,
        onShowExistingRemoteMcpChange: () => undefined,
      }),
    );

    expect(html).toContain("sm:flex-row");
    expect(html).toContain("sm:justify-between");
    expect(html.indexOf("Target: alice@dev.example.com:22")).toBeLessThan(
      html.indexOf("Show existing remote MCP servers"),
    );
  });
});
