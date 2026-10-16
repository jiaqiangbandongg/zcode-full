import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { copyGenUiRuntimeAssets } from "./gen-ui-runtime-assets.mjs";

it("packages the same pinned runtime assets used by standalone export", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gen-ui-assets-"));
  const source = new URL(
    "../../../apps/zcode-cli/packages/visualize-plugin/skills/visualize/assets/",
    import.meta.url,
  );
  const manifest = JSON.parse(await readFile(new URL("runtime-manifest.json", source), "utf8"));
  try {
    // 清单只承载当前资源的完整性数据，避免把无关的构建元数据带入分发包。
    expect(Object.keys(manifest)).toEqual(["files"]);
    expect(Object.keys(manifest.files).sort()).toEqual([
      "calendar.js",
      "tweak.js",
      "visualize.css",
      "visualize.html",
    ]);
    for (const entry of Object.values(manifest.files)) {
      expect(Object.keys(entry as object)).toEqual(["sha256"]);
    }
    await copyGenUiRuntimeAssets(directory);
    const vendors = JSON.parse(await readFile(join(directory, "vendor/manifest.json"), "utf8"));
    for (const resource of vendors.resources) {
      for (const [file, hash] of [
        [resource.file, resource.sha256],
        [resource.licenseFile, resource.licenseSha256],
      ]) {
        const bytes = await readFile(join(directory, "vendor", file));
        expect(bytes).toEqual(await readFile(new URL(`vendor/${file}`, source)));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
      }
    }
    for (const file of ["visualize.css", "visualize.html", "calendar.js"]) {
      const bytes = await readFile(join(directory, file));
      expect(bytes).toEqual(await readFile(new URL(file, source)));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.files[file].sha256);
    }
    const tweak = await readFile(
      new URL("../src/renderer/src/plugin-sandbox/genUiTweakRuntime.js", import.meta.url),
    );
    expect(createHash("sha256").update(tweak).digest("hex")).toBe(
      manifest.files["tweak.js"].sha256,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
