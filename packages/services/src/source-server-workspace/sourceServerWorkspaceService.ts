import {
  sourceServerResolveWorkspaceRequestSchema,
  sourceServerResolveWorkspaceResultSchema,
  sourceServerMigrationPathActionSchema,
  sourceServerMigrationReportSchema,
} from "@zcode/shared";
import { SourceServerWorkspaceAliasRepo } from "../session/sourceServerWorkspaceAliasRepo.js";
import type { ISourceServerWorkspaceService } from "./sourceServerWorkspace.js";

export function createSourceServerWorkspaceService(
  repo: Pick<
    SourceServerWorkspaceAliasRepo,
    | "resolveCanonicalWorkspaceKey"
    | "getFailedPathCount"
    | "getAbandonedPathCount"
    | "listMigrationReports"
    | "abandonFailedWorkspace"
    | "retryFailedWorkspace"
  > = new SourceServerWorkspaceAliasRepo(),
  options: {
    defaultWorkspaceIdentity?: (workspacePath: string) => string;
    onResolved?: (mapping: {
      workspacePath: string;
      canonicalWorkspaceKey: string;
    }) => void | Promise<void>;
  } = {},
): ISourceServerWorkspaceService {
  return {
    async resolveWorkspace(rawRequest) {
      const request = sourceServerResolveWorkspaceRequestSchema.parse(rawRequest);
      const result = await repo.resolveCanonicalWorkspaceKey({
        ...request,
        legacyRouteHint:
          request.legacyRouteHint ?? options.defaultWorkspaceIdentity?.(request.workspacePath),
      });
      await options.onResolved?.({
        workspacePath: request.workspacePath,
        canonicalWorkspaceKey: result.canonicalKey,
      });
      return sourceServerResolveWorkspaceResultSchema.parse({
        canonicalWorkspaceKey: result.canonicalKey,
        mergedKeys: result.mergedKeys,
        ...(result.migrationId ? { migrationId: result.migrationId } : {}),
      });
    },
    async getFailedPathCount() {
      return await repo.getFailedPathCount();
    },
    async getAbandonedPathCount() {
      return await repo.getAbandonedPathCount();
    },
    async listMigrationReports() {
      return sourceServerMigrationReportSchema.parse(await repo.listMigrationReports());
    },
    async abandonFailedWorkspace(rawRequest) {
      const request = sourceServerMigrationPathActionSchema.parse(rawRequest);
      await repo.abandonFailedWorkspace(request.workspacePath, request.migrationId);
      return sourceServerMigrationReportSchema.parse(await repo.listMigrationReports());
    },
    async retryWorkspaceMigration(rawRequest) {
      const request = sourceServerMigrationPathActionSchema.parse(rawRequest);
      await repo.retryFailedWorkspace(request.workspacePath, request.migrationId);
      return sourceServerMigrationReportSchema.parse(await repo.listMigrationReports());
    },
  };
}
