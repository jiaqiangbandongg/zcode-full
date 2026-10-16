import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { buildPluginSandboxPluginOrigin, type PluginSandboxRecord } from "./contract.js";

const manifestSchema = z
  .object({
    resources: z
      .array(
        z.object({
          url: z.url().startsWith("https://"),
          file: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.js$/),
        }),
      )
      .min(1),
  })
  .refine(
    ({ resources }) =>
      new Set(resources.map((item) => item.url)).size === resources.length &&
      new Set(resources.map((item) => item.file)).size === resources.length,
    "Duplicate bundled resource",
  );

/** 每个 partition 共用一份只读清单；不下载、不缓存远程响应。 */
export function createGenUiVendorResources(
  aliasDir: string,
  readAsset: (path: string) => Promise<Uint8Array> = readFile,
) {
  let pending: Promise<z.infer<typeof manifestSchema>["resources"]> | undefined;
  const read = () =>
    (pending ??= readAsset(join(aliasDir, "vendor/manifest.json")).then(
      (bytes) => manifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).resources,
    ));
  return {
    fileForUrl: async (url: string) => (await read()).find((item) => item.url === url)?.file,
    hasFile: async (file: string) => (await read()).some((item) => item.file === file),
  };
}
export type GenUiVendorResources = ReturnType<typeof createGenUiVendorResources>;

export async function resolveGenUiVendorRedirect(
  url: string,
  record: PluginSandboxRecord | null,
  resources: GenUiVendorResources,
): Promise<string | undefined> {
  if (record?.contentKind !== "gen-ui") return undefined;
  const file = await resources.fileForUrl(url);
  return file
    ? `${buildPluginSandboxPluginOrigin(record.instance.appIdentity)}/instance/${record.sandboxId}/__zcode__/vendor/${file}`
    : undefined;
}
