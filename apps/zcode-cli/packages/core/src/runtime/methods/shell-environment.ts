import type { ExecutionShellSelection } from "../deps.js";
import type { BashShellSnapshotRestore } from "./bash-shell-snapshot.js";

export type ShellEnvironmentResumeNoticeKind =
  | "display_change"
  | "windows_git_bash_auto_migration";

export function getShellEnvironmentResumeNoticeKind(options: {
  persistedShell: string | undefined;
  restoreStatus: BashShellSnapshotRestore["status"];
  selection: ExecutionShellSelection | undefined;
}): ShellEnvironmentResumeNoticeKind | undefined {
  if (!options.selection || options.restoreStatus === "restored") {
    return undefined;
  }

  if (isWindowsGitBashAutoMigration(options.selection)) {
    return "windows_git_bash_auto_migration";
  }

  return hasShellDisplayChanged(options.persistedShell, options.selection)
    ? "display_change"
    : undefined;
}

export function buildShellEnvironmentResumeNotice(
  kind: ShellEnvironmentResumeNoticeKind,
  selection: ExecutionShellSelection,
): string {
  if (kind === "windows_git_bash_auto_migration") {
    return "The Bash tool shell is Git Bash.";
  }

  return `The Bash tool shell is ${selection.display.name}.`;
}

export function hasShellDisplayChanged(
  previousShell: string | undefined,
  selection: ExecutionShellSelection | undefined,
): selection is ExecutionShellSelection {
  const previousDisplayName = normalizeShellDisplayName(previousShell);
  const nextDisplayName = normalizeShellDisplayName(selection?.display.name);
  return previousDisplayName !== undefined && nextDisplayName !== undefined
    ? previousDisplayName !== nextDisplayName
    : false;
}

function isWindowsGitBashAutoMigration(selection: ExecutionShellSelection): boolean {
  return selection.dialect === "git-bash" && selection.source === "auto-detected";
}

function normalizeShellDisplayName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
