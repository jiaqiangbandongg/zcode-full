import type { ProjectCatalogPort } from "#src/project-catalog/contract.js";
import { readProjectCatalog } from "#src/project-catalog/index.js";
export async function example(port: ProjectCatalogPort) {
  return (await readProjectCatalog(port)).projects.map((project) => project.name);
}
