// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SKILL_SYNC_SIZE_LIMIT_ERROR_CODE } from "@zcode/shared";
import type { ISkillSyncService } from "@zcode/services";
import {
  buildRemoteSkillSyncRows,
  filterRemoteSkillSyncRows,
  formatRemoteSkillSyncTarget,
  getRemoteSkillSyncBulkSelectionState,
  RemoteSkillSyncBulkSelectionCheckbox,
  RemoteSkillSyncDialog,
  RemoteSkillSyncExistingFilterCheckbox,
  RemoteSkillSyncSelectionList,
  RemoteSkillSyncTargetRow,
  formatRemoteSkillSyncError,
  resolveDefaultRemoteSkillSyncSelection,
  shouldToggleRemoteSkillSyncCardSelection,
} from "../src/settings/RemoteSkillSyncDialog.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

const controlHintTooltipMockState = vi.hoisted(() => ({
  latest: null as null | {
    hasOnMouseEnter: boolean;
    hasOnMouseLeave: boolean;
    open: boolean | undefined;
    tabIndex: unknown;
  },
}));

const remoteSkillSyncIntlMockState = vi.hoisted(() => ({
  locale: "en-US" as "en-US" | "zh-CN",
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
  useZCodeIntl: () => {
    const locale = remoteSkillSyncIntlMockState.locale;
    return {
      intl: {
        formatMessage: (
          { id }: { id: string },
          values?: Record<string, string | number>,
        ) => {
          const messages: Record<string, string> = {
            "settings.skills.remoteSync.title": "Sync Skills to remote target",
            "settings.skills.remoteSync.warningTitle": "Skill data and environment availability",
            "settings.skills.remoteSync.warningDescription":
              "Sync migrates local user-level Skills to the remote host, but not all dependent data and system environment capabilities can be guaranteed. If a Skill is unavailable because of the remote environment, permissions, or missing dependencies, install it or add the dependencies on the remote server.",
            "settings.skills.remoteSync.target": `Target: ${values?.target ?? ""}`,
            "settings.skills.remoteSync.loading": "Loading local Skills...",
            "settings.skills.remoteSync.empty": "No local user skills found.",
            "settings.skills.remoteSync.selectAll": "Select all",
            "settings.skills.remoteSync.clearAll": "Clear all",
            "settings.skills.remoteSync.start": "Sync selected",
            "settings.skills.remoteSync.syncing": "Syncing skills...",
            "settings.remoteSync.preflighting": "Checking remote write access...",
            "settings.skills.remoteSync.existing": "Already exists on remote",
            "settings.skills.remoteSync.showExisting": "Show existing remote skills",
            "settings.skills.remoteSync.expandDescription": "Show more",
            "settings.skills.remoteSync.collapseDescription": "Show less",
            "settings.skills.remoteSync.synced": "Synced",
            "settings.skills.remoteSync.skipped": "Skipped",
            "settings.skills.remoteSync.failed": "Failed",
            "settings.skills.remoteSync.complete": "Skill sync complete.",
            "settings.skills.remoteSync.selectionCount": `${values?.selected ?? 0}/${values?.total ?? 0} selected`,
            "settings.skills.remoteSync.noSelection": "Select at least one missing skill.",
            "settings.skills.remoteSync.sizeLimit.selectedContent":
              locale === "zh-CN"
                ? "同步失败：所选 Skills 的内容总大小约为 {actualSize}，超过单次同步上限 {maxSize}。请取消选择部分 Skills 后重试；远端未写入任何内容。"
                : "Sync failed: the selected Skills contain about {actualSize} of content, exceeding the {maxSize} per-sync limit. Deselect some Skills and try again. Nothing was written to the remote host.",
          };
          let message = messages[id] ?? id;
          for (const [key, value] of Object.entries(values ?? {})) {
            message = message.replaceAll(`{${key}}`, String(value));
          }
          return message;
        },
      },
    };
  },
}));

afterEach(() => {
  cleanup();
  remoteSkillSyncIntlMockState.locale = "en-US";
});

function createSkillSyncServiceStub(): ISkillSyncService {
  return {
    listLocalUserSkillCandidates: vi.fn(async () => ({
      maxArchiveBytes: 1024 * 1024,
      candidates: [],
    })),
    listRemoteUserSkillStatuses: vi.fn(async () => ({ statuses: [] })),
    exportSkillsArchive: vi.fn(async () => ({
      archive: new Uint8Array(),
      archiveBytes: 0,
      skills: [],
    })),
    checkRemoteUserSkillWriteAccess: vi.fn(async () => ({
      ok: true,
      path: "/home/dev/.zcode/skills",
    })),
    importSkillsArchive: vi.fn(async () => ({ results: [] })),
  };
}

describe("RemoteSkillSyncDialog helpers", () => {
  it("provides size-limit copy in both supported locales", () => {
    const messageIds = [
      "settings.skills.remoteSync.sizeLimit.selectedContent",
      "settings.skills.remoteSync.sizeLimit.archive",
      "settings.skills.remoteSync.sizeLimit.extractedContent",
    ];

    for (const messageId of messageIds) {
      expect(enUS[messageId]).toBeTruthy();
      expect(zhCN[messageId]).toBeTruthy();
    }
  });

  it("localizes structured selected-content size limit errors", () => {
    const error = Object.assign(new Error("skill sync size limit exceeded"), {
      code: SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
      data: {
        actualBytes: 56_220_152,
        maxBytes: 20 * 1024 * 1024,
        phase: "selected-content",
      },
    });

    expect(
      formatRemoteSkillSyncError(error, {
        formatMessage: ({ id }, values) => {
          const messages: Record<string, string> = {
            "settings.skills.remoteSync.sizeLimit.selectedContent":
              "Sync failed: the selected Skills contain about {actualSize} of content, exceeding the {maxSize} per-sync limit. Deselect some Skills and try again. Nothing was written to the remote host.",
          };
          let message = messages[id] ?? id;
          for (const [key, value] of Object.entries(values ?? {})) {
            message = message.replaceAll(`{${key}}`, String(value));
          }
          return message;
        },
      }),
    ).toBe(
      "Sync failed: the selected Skills contain about 53.6 MiB of content, exceeding the 20 MiB per-sync limit. Deselect some Skills and try again. Nothing was written to the remote host.",
    );
  });

  it("marks remote existing skills and selects only missing ones by default", () => {
    const rows = buildRemoteSkillSyncRows(
      [
        {
          id: "missing-id",
          name: "review",
          directoryName: "review",
          description: "Review code",
          path: "/Users/me/.zcode/skills/review/SKILL.md",
          sizeBytes: 128,
        },
        {
          id: "existing-id",
          name: "docs",
          directoryName: "docs",
          description: "Write docs",
          path: "/Users/me/.zcode/skills/docs/SKILL.md",
          sizeBytes: 64,
        },
      ],
      [{ directoryName: "docs", exists: true }],
    );

    expect(rows.map((row) => ({ id: row.candidate.id, exists: row.exists }))).toEqual([
      { id: "missing-id", exists: false },
      { id: "existing-id", exists: true },
    ]);
    expect(Array.from(resolveDefaultRemoteSkillSyncSelection(rows))).toEqual(["missing-id"]);
  });

  it("formats SSH target with workspace path when available", () => {
    expect(
      formatRemoteSkillSyncTarget(
        { kind: "ssh", host: "dev.example.com", username: "alice", port: 22 },
        "/home/alice/project",
      ),
    ).toBe("alice@dev.example.com:22 · /home/alice/project");
  });

  it("formats WSL target with distro, user, and workspace path", () => {
    expect(
      formatRemoteSkillSyncTarget(
        { kind: "wsl", distro: "Ubuntu-24.04", user: "alice" },
        "/home/alice/project",
      ),
    ).toBe("WSL · Ubuntu-24.04 · alice · /home/alice/project");
  });

  it("toggles selection only from non-action card clicks on missing skills", () => {
    const plainCardTarget = { closest: vi.fn(() => null) } as unknown as EventTarget;
    const actionTarget = { closest: vi.fn(() => ({})) } as unknown as EventTarget;

    expect(
      shouldToggleRemoteSkillSyncCardSelection({
        exists: false,
        target: plainCardTarget,
      }),
    ).toBe(true);
    expect(
      shouldToggleRemoteSkillSyncCardSelection({
        exists: false,
        target: actionTarget,
      }),
    ).toBe(false);
    expect(
      shouldToggleRemoteSkillSyncCardSelection({
        exists: true,
        target: plainCardTarget,
      }),
    ).toBe(false);
  });

  it("derives the bulk selection checkbox state", () => {
    expect(
      getRemoteSkillSyncBulkSelectionState({
        selectedCount: 0,
        totalSelectable: 0,
      }),
    ).toEqual({ checked: false, disabled: true, indeterminate: false });
    expect(
      getRemoteSkillSyncBulkSelectionState({
        selectedCount: 1,
        totalSelectable: 3,
      }),
    ).toEqual({ checked: false, disabled: false, indeterminate: true });
    expect(
      getRemoteSkillSyncBulkSelectionState({
        selectedCount: 3,
        totalSelectable: 3,
      }),
    ).toEqual({ checked: true, disabled: false, indeterminate: false });
  });

  it("filters remote existing rows when the existing filter is disabled", () => {
    const rows = buildRemoteSkillSyncRows(
      [
        {
          id: "missing-id",
          name: "review",
          directoryName: "review",
          description: "Review code",
          path: "/Users/me/.zcode/skills/review/SKILL.md",
          sizeBytes: 128,
        },
        {
          id: "existing-id",
          name: "docs",
          directoryName: "docs",
          description: "Write docs",
          path: "/Users/me/.zcode/skills/docs/SKILL.md",
          sizeBytes: 64,
        },
      ],
      [{ directoryName: "docs", exists: true }],
    );

    expect(filterRemoteSkillSyncRows(rows, true).map((row) => row.candidate.id)).toEqual([
      "missing-id",
      "existing-id",
    ]);
    expect(filterRemoteSkillSyncRows(rows, false).map((row) => row.candidate.id)).toEqual([
      "missing-id",
    ]);
  });
});

describe("RemoteSkillSyncDialog", () => {
  it("uses the current locale when a pending load later fails", async () => {
    let rejectFirstLoad: (error: unknown) => void = () => undefined;
    const firstLoad = new Promise<never>((_, reject) => {
      rejectFirstLoad = reject;
    });
    const sizeLimitError = Object.assign(new Error("skill sync size limit exceeded"), {
      code: SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
      data: {
        actualBytes: 56_220_152,
        maxBytes: 20 * 1024 * 1024,
        phase: "selected-content",
      },
    });
    const service = createSkillSyncServiceStub();
    service.listLocalUserSkillCandidates = vi.fn().mockReturnValueOnce(firstLoad);
    const props = {
      open: true,
      onOpenChange: () => undefined,
      localSkillSyncService: service,
      remoteSkillSyncService: service,
      remoteTarget: {
        kind: "ssh" as const,
        host: "dev.example.com",
        username: "alice",
        port: 22,
      },
      workspacePath: "/home/alice/project",
      onSynced: async () => undefined,
    };

    const view = render(createElement(RemoteSkillSyncDialog, props));
    remoteSkillSyncIntlMockState.locale = "zh-CN";
    view.rerender(createElement(RemoteSkillSyncDialog, props));
    rejectFirstLoad(sizeLimitError);

    await waitFor(() => {
      expect(
        screen.getByText(
          "同步失败：所选 Skills 的内容总大小约为 53.6 MiB，超过单次同步上限 20 MiB。请取消选择部分 Skills 后重试；远端未写入任何内容。",
        ),
      ).toBeTruthy();
    });
  });

  it("renders SSH target in the loading state", () => {
    const service = createSkillSyncServiceStub();

    const html = renderToStaticMarkup(
      createElement(RemoteSkillSyncDialog, {
        open: true,
        onOpenChange: () => undefined,
        localSkillSyncService: service,
        remoteSkillSyncService: service,
        remoteTarget: {
          kind: "ssh",
          host: "dev.example.com",
          username: "alice",
          port: 22,
        },
        workspacePath: "/home/alice/project",
        workspaceIdentity: "ssh://alice@dev.example.com/home/alice/project",
        onSynced: async () => undefined,
      }),
    );

    expect(html).toContain("Sync Skills to remote target");
    expect(html).toContain("alice@dev.example.com:22");
    expect(html).toContain("/home/alice/project");
  });

  it("renders a warning tooltip next to the sync title", () => {
    const service = createSkillSyncServiceStub();
    controlHintTooltipMockState.latest = null;

    const html = renderToStaticMarkup(
      createElement(RemoteSkillSyncDialog, {
        open: true,
        onOpenChange: () => undefined,
        localSkillSyncService: service,
        remoteSkillSyncService: service,
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

    expect(html).toContain("Sync Skills to remote target");
    expect(html).toContain('data-tooltip-title="Skill data and environment availability"');
    expect(html).toContain("not all dependent data and system environment capabilities");
    expect(html).toContain("install it or add the dependencies on the remote server");
    expect(html).toContain('aria-label="Skill data and environment availability"');
  });

  it("keeps the warning tooltip closed until mouse hover", () => {
    const service = createSkillSyncServiceStub();
    controlHintTooltipMockState.latest = null;

    const html = renderToStaticMarkup(
      createElement(RemoteSkillSyncDialog, {
        open: true,
        onOpenChange: () => undefined,
        localSkillSyncService: service,
        remoteSkillSyncService: service,
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

    expect(html).toContain('data-tooltip-open="false"');
    expect(html).not.toContain('tabIndex="0"');
    expect(html).not.toContain('tabindex="0"');
    expect(controlHintTooltipMockState.latest).toEqual({
      hasOnMouseEnter: true,
      hasOnMouseLeave: true,
      open: false,
      tabIndex: undefined,
    });
  });

  it("keeps the dialog size stable while the skill list scrolls", () => {
    const service = createSkillSyncServiceStub();

    const html = renderToStaticMarkup(
      createElement(RemoteSkillSyncDialog, {
        open: true,
        onOpenChange: () => undefined,
        localSkillSyncService: service,
        remoteSkillSyncService: service,
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

  it("collapses skill descriptions by default with an expand control", () => {
    const rows = buildRemoteSkillSyncRows(
      [
        {
          id: "lark-apps-id",
          name: "lark-apps",
          directoryName: "lark-apps",
          description:
            "A long skill description that should not take multiple lines in the default sync picker view.",
          path: "/Users/me/.agents/skills/lark-apps/SKILL.md",
          sizeBytes: 128,
        },
      ],
      [],
    );

    const html = renderToStaticMarkup(
      createElement(RemoteSkillSyncSelectionList, {
        rows,
        selectedIds: new Set(["lark-apps-id"]),
        onToggle: () => undefined,
      }),
    );

    expect(html).toContain("line-clamp-1");
    const descriptionClass =
      html.match(/class="([^"]*line-clamp-1[^"]*)"/u)?.[1] ?? "";
    expect(descriptionClass.split(/\s+/u)).not.toContain("block");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Show more"');
    expect(html).toContain("data-remote-skill-sync-card-action");
    expect(html).not.toContain(">Show more</button>");
  });

  it("renders bulk selection as a single checkbox control", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteSkillSyncBulkSelectionCheckbox, {
        selectedCount: 1,
        totalSelectable: 3,
        onSelectAll: () => undefined,
        onClearAll: () => undefined,
      }),
    );

    expect(html).toContain('type="checkbox"');
    expect(html).toContain('aria-checked="mixed"');
    expect(html).toContain("Select all");
    expect(html).not.toContain("Clear all");
  });

  it("renders the existing remote skills filter as a checkbox control", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteSkillSyncExistingFilterCheckbox, {
        checked: false,
        onCheckedChange: () => undefined,
      }),
    );

    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Show existing remote skills");
  });

  it("places the existing filter on the same row as the target", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteSkillSyncTargetRow, {
        targetLabel: "alice@dev.example.com:22 · /home/alice/project",
        showExistingRemoteSkills: true,
        showExistingFilter: true,
        onShowExistingRemoteSkillsChange: () => undefined,
      }),
    );

    expect(html).toContain("sm:flex-row");
    expect(html).toContain("sm:justify-between");
    expect(html.indexOf("Target: alice@dev.example.com:22")).toBeLessThan(
      html.indexOf("Show existing remote skills"),
    );
  });

});
