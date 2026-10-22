import type { IRemoteProjectService, RemoteProjectCache } from "#src/remote-projects/contract.js";

export async function refreshAddedProject(
  service: IRemoteProjectService,
  entryId: string,
  read: () => Promise<RemoteProjectCache>,
): Promise<boolean> {
  const entry = (await service.readDirectory()).entries.find((item) => item.id === entryId);
  if (!entry) return false;
  const project = await read();
  return service.refreshEntry({ entryId, expectedLastSyncedAt: entry.lastSyncedAt, project });
}
