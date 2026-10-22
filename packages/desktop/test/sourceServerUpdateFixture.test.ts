import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { prepareSourceServerUpdateArchive } from "./e2e/helpers/source-server-update-fixture.js";
afterEach(() => vi.unstubAllEnvs());

it("更新 fixture 解除 staged 硬链接，不能污染另一 case 的公共 archive/descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-update-fixture-"));
  try {
    const desktopRoot = join(root, "packages/desktop");
    const release = join(desktopRoot, ".e2e-cache/r3-server-fixture/mock-cdn/releases/1.0.0");
    const work = join(root, "input");
    await mkdir(join(work, "server/runtime"), { recursive: true });
    await mkdir(release, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
    await writeFile(join(work, "server/runtime/entry.js"), "original");
    const archive = join(root, "zcode-server-linux-x64.tar.gz");
    await promisify(execFile)("tar", ["-czf", archive, "-C", work, "server"]);
    const original = await readFile(archive);
    const sha = createHash("sha256").update(original).digest("hex");
    const descriptor = JSON.stringify({
      schemaVersion: 1,
      version: "1.0.0",
      archives: [
        {
          target: "linux-x64",
          version: "1.0.0",
          fileName: "zcode-server-linux-x64.tar.gz",
          sha256: sha,
          sizeBytes: original.length,
          urls: ["zcode-server-linux-x64.tar.gz"],
        },
      ],
    });
    const publicDescriptor = join(root, "descriptor.json");
    await writeFile(publicDescriptor, descriptor);
    await link(archive, join(release, "zcode-server-linux-x64.tar.gz"));
    await link(publicDescriptor, join(release, "source-server-release.json"));
    vi.stubEnv("ZCODE_E2E_RUN_ID", "r3-server-fixture");
    vi.stubEnv("ZCODE_E2E_ARTIFACT_DIR", join(root, "artifacts"));
    const result = await prepareSourceServerUpdateArchive(sha, "E2E_UPDATE", { desktopRoot });
    expect(result.newSha).not.toBe(sha);
    expect(await readFile(archive)).toEqual(original);
    expect(await readFile(publicDescriptor, "utf8")).toBe(descriptor);
    expect(
      JSON.parse(await readFile(join(release, "source-server-release.json"), "utf8")).archives[0]
        .sha256,
    ).toBe(result.newSha);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
