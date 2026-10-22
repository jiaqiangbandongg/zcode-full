import { z } from "zod";

export const SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE =
  "source-server-install-required" as const;
export const SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE =
  "source-server-upgrade-required" as const;
export const SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE =
  "source-server-update-running-tasks" as const;
export const WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE =
  "workspace-task-identity-conflict" as const;
export const WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE =
  "workspace-config-file-conflict" as const;
export const WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE =
  "workspace-migration-plan-diverged" as const;
export const WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE =
  "workspace-session-generation-changed" as const;
export const REMOTE_BIND_CANCELED_ERROR_CODE = "remote-bind-canceled" as const;
export const REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE =
  "remote-workspace-bind-session-missing" as const;
export const REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE =
  "remote-workspace-directory-unavailable" as const;
export const REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE =
  "remote-recovery-budget-exhausted" as const;
export const SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE =
  "source-server-identity-change-pending" as const;
export const SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE =
  "source-server-remove-callback-missing" as const;
export const SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE =
  "source-server-remove-callback-failed" as const;
export const SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE =
  "source-server-remove-persist-failed" as const;

export const PUBLIC_ZCODE_ERROR_CODES = [
  "remote-authentication-failed",
  "remote-host-unreachable",
  "remote-connection-timeout",
  "remote-host-not-found",
  "remote-host-key-changed",
  "remote-download-failed",
  "remote-upload-failed",
  "remote-preflight-failed",
  "remote-install-failed",
  "remote-space-insufficient",
  "remote-permission-denied",
  "remote-connection-canceled",
  "remote-connection-unknown",
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE,
  WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE,
  WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE,
  WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
  REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE,
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE,
  SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE,
  SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
] as const;

export type PublicZCodeErrorCode = (typeof PUBLIC_ZCODE_ERROR_CODES)[number];

export const publicZCodeErrorCodeSchema = z.enum(PUBLIC_ZCODE_ERROR_CODES);

const publicZCodeErrorCodeSet = new Set<string>(PUBLIC_ZCODE_ERROR_CODES);

export function isPublicZCodeErrorCode(
  value: unknown,
): value is PublicZCodeErrorCode {
  return typeof value === "string" && publicZCodeErrorCodeSet.has(value);
}
