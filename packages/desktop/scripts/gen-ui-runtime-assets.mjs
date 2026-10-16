import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const source = new URL(
  "../../../apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/",
  import.meta.url,
);

/** Inline 和导出共用实际资源文件，避免维护另一份有细节差异的运行时。 */
export async function copyGenUiRuntimeAssets(destination) {
  const manifest = JSON.parse(await readFile(new URL("vendor/manifest.json", source), "utf8"));
  const vendorFiles = new Map();
  for (const resource of manifest.resources) {
    vendorFiles.set(resource.file, resource.sha256);
    vendorFiles.set(resource.licenseFile, resource.licenseSha256);
  }
  // 离线运行依赖完整的固定快照；构建时发现缺失或漂移，不能把失败留到用户首次打开。
  await Promise.all(
    [...vendorFiles].map(async ([file, expectedHash]) => {
      if (!/^[a-zA-Z0-9.-]+$/.test(file)) throw new Error(`Invalid Gen UI vendor file: ${file}`);
      const bytes = await readFile(new URL(`vendor/${file}`, source));
      if (createHash("sha256").update(bytes).digest("hex") !== expectedHash)
        throw new Error(`Gen UI vendor hash mismatch: ${file}`);
    }),
  );
  await mkdir(destination, { recursive: true });
  await mkdir(join(destination, "vendor"), { recursive: true });
  await Promise.all(
    [
      "visualize.css",
      "visualize.html",
      "calendar.js",
      "vendor/manifest.json",
      ...[...vendorFiles.keys()].map((file) => `vendor/${file}`),
    ].map((file) => copyFile(new URL(file, source), join(destination, file))),
  );
}
