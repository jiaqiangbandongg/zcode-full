import type {
  SourceServerMigrationReport,
  SourceServerMigrationReportRow,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getSourceMigrationPhaseMessageId,
  getSourceMigrationStatusMessageId,
} from "@/settings/sourceServerManagementPresentation.js";

function getStatusChipClassName(
  status: SourceServerMigrationReportRow["status"],
): string {
  switch (status) {
    case "failed":
      return "bg-destructive-surface text-destructive-surface-foreground";
    case "completed":
      return "bg-success-surface text-success-surface-foreground";
    case "running":
      return "bg-warning-surface text-warning-surface-foreground";
    case "abandoned":
    case "abandoned-diverged":
      return "bg-tag text-foreground-subtle";
  }
}

export function SourceServerMigrationReportPanel({
  report,
  onAbandon,
  onRetry,
  disabled = false,
}: {
  report: SourceServerMigrationReport;
  disabled?: boolean;
  onAbandon: (workspacePath: string, migrationId: string) => void;
  onRetry: (workspacePath: string, migrationId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const latestMigrationIdByPath = new Map<string, string>();
  for (const row of report.rows) {
    if (!latestMigrationIdByPath.has(row.workspacePath)) {
      latestMigrationIdByPath.set(row.workspacePath, row.migrationId);
    }
  }
  const renderRowDetail = (row: SourceServerMigrationReportRow): string => {
    if (row.status === "completed") {
      // 原型完成行「已合并 N 条线路的历史」，N = 被并入 canonical 的来源线路数。
      return row.variantKeys.length > 0
        ? intl.formatMessage(
            { id: "settings.source.migrationMergedHistory" },
            { count: row.variantKeys.length },
          )
        : "";
    }
    const detailMessageId = row.errorCode
      ? row.errorCode === "workspace-task-identity-conflict"
        ? "remote.error.workspaceTaskIdentityConflict"
        : row.errorCode === "workspace-config-file-conflict"
          ? "remote.error.workspaceConfigConflict"
          : row.errorCode === "workspace-migration-plan-diverged"
            ? "remote.error.workspaceMigrationPlanDiverged"
            : row.errorCode === "workspace-session-generation-changed"
              ? "remote.error.workspaceSessionGenerationChanged"
              : null
      : row.phase
        ? getSourceMigrationPhaseMessageId(row.phase)
        : null;
    const detail = detailMessageId
      ? intl.formatMessage({ id: detailMessageId })
      : intl.formatMessage({
          id: "settings.source.migrationDetailUnavailable",
        });
    return row.conflicts.length > 0
      ? `${detail} · ${intl.formatMessage(
          { id: "settings.source.migrationConflictCount" },
          { count: row.conflicts.length },
        )}`
      : detail;
  };
  return (
    <div className="px-4 pb-3">
      {report.rows.length === 0 ? (
        <p className="py-1.5 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.source.noMigrationIssues" })}
        </p>
      ) : (
        report.rows.map((row) => {
          const isLatestForPath =
            latestMigrationIdByPath.get(row.workspacePath) === row.migrationId;
          const detailText = renderRowDetail(row);
          const showActions =
            isLatestForPath &&
            (row.status === "failed" ||
              row.status === "abandoned" ||
              row.status === "abandoned-diverged");
          return (
            <div
              key={row.migrationId}
              className="flex min-w-0 flex-wrap items-center gap-2 py-1.5"
            >
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-ui-xs",
                  getStatusChipClassName(row.status),
                )}
              >
                {intl.formatMessage({
                  id: getSourceMigrationStatusMessageId(row.status),
                })}
              </span>
              <span title={row.workspacePath} className="min-w-0 truncate font-mono text-ui-sm text-foreground">
                {row.workspacePath}
              </span>
              {detailText ? (
                <span className="min-w-0 truncate text-ui-xs text-foreground-subtlest">
                  {detailText}
                </span>
              ) : null}
              {showActions ? (
                <span className="ml-auto flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={disabled}
                    onClick={() => onRetry(row.workspacePath, row.migrationId)}
                  >
                    {intl.formatMessage({
                      id: "settings.source.retryMigration",
                    })}
                  </Button>
                  {row.status === "failed" && !row.phase ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-destructive"
                      disabled={disabled}
                      onClick={() =>
                        onAbandon(row.workspacePath, row.migrationId)
                      }
                    >
                      {intl.formatMessage({
                        id: "settings.source.abandonMigration",
                      })}
                    </Button>
                  ) : null}
                </span>
              ) : null}
            </div>
          );
        })
      )}
      {/* 导出详情供客服或内部诊断工具调用，普通设置页不暴露 JSON 下载入口。 */}
    </div>
  );
}
