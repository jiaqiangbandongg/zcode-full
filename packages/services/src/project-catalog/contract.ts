import type { IProjectService, VirtualProject } from "#src/project/contract.js";
import type {
  IRemoteProjectService,
  RemoteProjectDirectory,
} from "#src/remote-projects/contract.js";
export type { VirtualProject, RemoteProjectDirectory };
export interface ProjectCatalogPort {
  projectService: Pick<IProjectService, "readProjects">;
  remoteProjectService?: Pick<IRemoteProjectService, "readDirectory">;
}
export interface ProjectCatalogSnapshot {
  projects: VirtualProject[];
  directory: RemoteProjectDirectory;
}
