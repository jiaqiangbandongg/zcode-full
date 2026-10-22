import type { ConfigCatalogPort } from "./contract.js";
import { readConfigCatalog, projectConfigTargets } from "./index.js";
export async function exampleWorkspaceConfigCatalog(port: ConfigCatalogPort) {
  return projectConfigTargets(await readConfigCatalog(port), []);
}
