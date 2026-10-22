import type { IProjectService } from "#src/project/contract.js";

export async function projectExample(service: IProjectService): Promise<string> {
  const project = await service.saveProject({
    roots: ["/workspace/frontend", "/workspace/backend"],
  });
  const directories = await service.readProjects();
  if (!directories.some((entry) => entry.id === project.id))
    throw new Error("Project not committed");
  const execution = await service.prepareSession({ projectId: project.id });
  return execution.workspacePath;
}
