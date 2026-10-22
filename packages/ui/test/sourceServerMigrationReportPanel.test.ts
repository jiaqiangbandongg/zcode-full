// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SourceServerMigrationReport } from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceServerMigrationReportPanel } from "../src/settings/SourceServerMigrationReportPanel.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

afterEach(cleanup);

describe("SourceServerMigrationReportPanel", () => {
  it("exposes whole-directory abandon and retry actions without a user-facing export", () => {
    const onAbandon = vi.fn();
    const onRetry = vi.fn();
    const report: SourceServerMigrationReport = {
      rows: [
        {
          migrationId: "migration-1",
          workspacePath: "/workspace/conflicted",
          canonicalKey: "remote:server:source-a:/workspace/conflicted",
          variantKeys: ["remote:ssh:host:22:user:/workspace/conflicted"],
          status: "failed",
          errorCode: "workspace-task-identity-conflict",
          updatedAt: 1,
          conflicts: [
            {
              kind: "task-identity",
              key: "task-1",
              taskId: "task-1",
              sourceKey: "remote:ssh:host:22:user:/workspace/conflicted",
              canonicalKey: "remote:server:source-a:/workspace/conflicted",
              reason: "same task id has divergent content",
            },
          ],
        },
      ],
    };

    render(
      createElement(SourceServerMigrationReportPanel, {
        report,
        onAbandon,
        onRetry,
      }),
    );

    expect(screen.getByText("/workspace/conflicted")).toBeTruthy();
    expect(screen.getByText(/remote\.error\.workspaceTaskIdentityConflict/u)).toBeTruthy();
    // 失败行说明带「N 处冲突」段（settings.source.migrationConflictCount）。
    expect(
      screen.getByText(/settings\.source\.migrationConflictCount/u),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /abandonMigration/u }));
    fireEvent.click(screen.getByRole("button", { name: /retryMigration/u }));

    expect(screen.queryByRole("button", { name: /exportMigrationReport/u })).toBeNull();
    expect(screen.getByText("/workspace/conflicted").getAttribute("title")).toBe("/workspace/conflicted");
    expect(onAbandon).toHaveBeenCalledWith("/workspace/conflicted", "migration-1");
    expect(onRetry).toHaveBeenCalledWith("/workspace/conflicted", "migration-1");
  });

  it("does not offer abandon for a resumable phase", () => {
    const report: SourceServerMigrationReport = {
      rows: [
        {
          migrationId: "resume",
          workspacePath: "/repo",
          canonicalKey: "remote:server:s:/repo",
          variantKeys: [],
          status: "failed",
          phase: "backups-created",
          updatedAt: 1,
          conflicts: [],
        },
      ],
    };
    render(
      createElement(SourceServerMigrationReportPanel, {
        report,
        onAbandon: vi.fn(),
        onRetry: vi.fn(),
      }),
    );
    expect(screen.queryByRole("button", { name: /abandonMigration/u })).toBeNull();
  });

  it("only exposes actions for the latest migration of a workspace path", () => {
    const onRetry = vi.fn();
    const report: SourceServerMigrationReport = {
      rows: [
        {
          migrationId: "newest",
          workspacePath: "/repo",
          canonicalKey: "remote:server:s:/repo",
          variantKeys: [],
          status: "failed",
          updatedAt: 2,
          conflicts: [],
        },
        {
          migrationId: "stale",
          workspacePath: "/repo",
          canonicalKey: "remote:server:s:/repo",
          variantKeys: [],
          status: "failed",
          updatedAt: 1,
          conflicts: [],
        },
      ],
    };
    render(
      createElement(SourceServerMigrationReportPanel, {
        report,
        onAbandon: vi.fn(),
        onRetry,
      }),
    );

    const retryButtons = screen.getAllByRole("button", { name: /retryMigration/u });
    expect(retryButtons).toHaveLength(1);
    fireEvent.click(retryButtons[0]!);
    expect(onRetry).toHaveBeenCalledWith("/repo", "newest");
  });

  it("allows an abandoned-diverged directory to re-enter forward-only merge", () => {
    const onRetry = vi.fn();
    const report: SourceServerMigrationReport = {
      rows: [
        {
          migrationId: "migration-2",
          workspacePath: "/workspace/diverged",
          canonicalKey: "remote:server:source-a:/workspace/diverged",
          variantKeys: ["remote:docker:container:/workspace/diverged"],
          status: "abandoned-diverged",
          updatedAt: 2,
          abandonedAt: 1,
          conflicts: [],
        },
      ],
    };

    render(
      createElement(SourceServerMigrationReportPanel, {
        report,
        onAbandon: vi.fn(),
        onRetry,
      }),
    );

    expect(screen.queryByRole("button", { name: /abandonMigration/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retryMigration/u }));
    expect(onRetry).toHaveBeenCalledWith("/workspace/diverged", "migration-2");
  });

  it("describes a completed row with the merged-history count instead of a bare number", () => {
    const report: SourceServerMigrationReport = {
      rows: [
        {
          migrationId: "done",
          workspacePath: "/home/dev",
          canonicalKey: "remote:server:s:/home/dev",
          variantKeys: [
            "remote:ssh:a:22:u:/home/dev",
            "remote:ssh:b:22:u:/home/dev",
          ],
          status: "completed",
          updatedAt: 1,
          conflicts: [],
        },
      ],
    };
    render(
      createElement(SourceServerMigrationReportPanel, {
        report,
        onAbandon: vi.fn(),
        onRetry: vi.fn(),
      }),
    );
    // 完成行说明使用「已合并 N 条线路的历史」（N=variantKeys 数），完成行不提供操作按钮。
    expect(screen.getByText(/settings\.source\.migrationMergedHistory/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retryMigration/u })).toBeNull();
  });
});
