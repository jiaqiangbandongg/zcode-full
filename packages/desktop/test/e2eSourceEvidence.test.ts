import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSourceFiles, withE2ESourceEvidence } from "./e2e/reporting/e2e-source-evidence.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function setup() {
  directory = await mkdtemp(join(tmpdir(), "e2e-source-evidence-"));
  const appOutputDir = join(directory, "app");
  await mkdir(appOutputDir);
  await writeFile(join(appOutputDir, "index.js"), "const fixture = 1;");
  return { appOutputDir, artifactDir: join(directory, "report") };
}
describe("E2E source evidence", () => {
  it("detects changed, added and deleted source files", () => {
    expect(changedSourceFiles({ a: "1", b: "2" }, { a: "3", c: "4" })).toEqual(["a", "b", "c"]);
  });
  it("records stable fresh source and staged artifacts", async () => {
    const paths = await setup();
    const build = vi.fn(async () => {});
    await withE2ESourceEvidence({
      ...paths,
      freshBuild: true,
      captureSources: async () => ({ "packages/ui/src/a.ts": "hash" }),
      build,
    });
    const evidence = JSON.parse(
      await readFile(join(paths.artifactDir, "build-source-evidence.json"), "utf8"),
    );
    expect(evidence.status).toBe("fresh-stable");
    expect(evidence.sources["packages/ui/src/a.ts"]).toBe("hash");
    expect(evidence.outputs["index.js"]).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.domains).toEqual(["renderer", "host", "main"]);
    expect(build).toHaveBeenCalledTimes(1);
  });
  it("does not validate a source edit during build", async () => {
    const paths = await setup();
    let version = "before";
    const evidence = await withE2ESourceEvidence({
      ...paths,
      freshBuild: true,
      captureSources: async () => ({ a: version }),
      build: async () => {
        version = "after";
      },
    });
    expect(evidence.status).toBe("source-changed-during-build");
    expect(evidence.changedFiles).toEqual(["a"]);
  });
  it("never assigns current sources to a reused build", async () => {
    const paths = await setup();
    const captureSources = vi.fn(async () => ({ a: "current" }));
    const evidence = await withE2ESourceEvidence({
      ...paths,
      freshBuild: false,
      captureSources,
      build: async () => {},
    });
    expect(evidence.status).toBe("unverified-reused-build");
    expect(evidence.sources).toEqual({});
    expect(captureSources).not.toHaveBeenCalled();
  });
  it("does not write a successful manifest when build fails", async () => {
    const paths = await setup();
    await expect(
      withE2ESourceEvidence({
        ...paths,
        freshBuild: true,
        captureSources: async () => ({ a: "1" }),
        build: async () => {
          throw new Error("build failed");
        },
      }),
    ).rejects.toThrow("build failed");
    await expect(
      readFile(join(paths.artifactDir, "build-source-evidence.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
