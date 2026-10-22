import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "#src/descriptors.js";
import type { IProjectService } from "#src/project/contract.js";
import type { IRemoteProjectService } from "#src/remote-projects/contract.js";

export interface IWindowProjectChangesService {
  getCapabilities(): Promise<{ version: 1 }>;
  onDidChange: Event<void>;
}

/** 整组选择，避免把窗口项目与 Source 成员目录或广播混用。 */
export interface WindowProjectDirectoryServices {
  projectService: IProjectService;
  remoteProjectService: IRemoteProjectService;
  changesService: IWindowProjectChangesService;
}

export const IWindowProjectService = createServiceDescriptor<IProjectService>(
  ServiceChannels.WindowProject,
);
export const IWindowRemoteProjectService = createServiceDescriptor<IRemoteProjectService>(
  ServiceChannels.WindowRemoteProjects,
);
export const IWindowProjectChangesService = createServiceDescriptor<IWindowProjectChangesService>(
  ServiceChannels.WindowProjectChanges,
);
