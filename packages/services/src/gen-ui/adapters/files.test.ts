import { mkdtemp, mkdir, readdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGenUiOutputDirectory } from "@zcode/shared/node";
import { readGenUiDocument } from "./files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(workspaceIdentity?: string, workspaceContainsOutput = false) {
  const root = await mkdtemp(join(tmpdir(), "zcode-gen-ui-"));
  roots.push(root);
  const workspacePath = workspaceContainsOutput ? root : join(root, "workspace"),
    outputRoot = join(root, "user-data", "visualizations");
  const scope = { workspacePath, workspaceIdentity, sessionId: "test" };
  const directory = getGenUiOutputDirectory(outputRoot, scope);
  await mkdir(workspacePath, { recursive: true });
  await mkdir(directory, { recursive: true });
  return { root, outputRoot, directory, target: { ...scope, path: join(directory, "chart.html") } };
}

describe("Gen UI executor file reader", () => {
  it.each([undefined, "ssh:executor:/workspace"])(
    "reads the session output without writing into Git (%s)",
    async (identity) => {
      const { outputRoot, target } = await fixture(identity);
      await writeFile(target.path, '<div id="chart">Hello</div>');
      expect((await readGenUiDocument(target, outputRoot)).html).toContain("Hello");
      expect(await readdir(target.workspacePath)).toEqual([]);
      expect(
        (await readGenUiDocument({ ...target, sessionId: "forked" }, outputRoot)).html,
      ).toContain("Hello");
      expect(
        (
          await readGenUiDocument(
            { ...target, workspaceIdentity: "ssh:other:/workspace" },
            outputRoot,
          )
        ).html,
      ).toContain("Hello");
    },
  );
  it.each([undefined, "ssh:executor:/home/dev"])(
    "reads the fixed session output when the workspace contains the output root (%s)",
    async (identity) => {
      const { outputRoot, target } = await fixture(identity, true);
      await writeFile(target.path, "<div>Home workspace</div>");
      expect((await readGenUiDocument(target, outputRoot)).html).toBe("<div>Home workspace</div>");
      expect((await readGenUiDocument({ ...target, sessionId: "forked" }, outputRoot)).html).toBe(
        "<div>Home workspace</div>",
      );
    },
  );
  it("rejects paths outside the host output root and symbolic links below it", async () => {
    const { outputRoot, target, directory } = await fixture();
    const oldPath = join(target.workspacePath, "chart.html");
    await writeFile(oldPath, "outside");
    await expect(readGenUiDocument({ ...target, path: oldPath }, outputRoot)).rejects.toThrow(
      "host output directory",
    );
    await symlink(oldPath, target.path);
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("symbolic links");
    await rm(directory, { recursive: true });
    await symlink(target.workspacePath, directory, "junction");
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("symbolic links");
  });
  it("reads through a host root alias even when its real path is inside the workspace", async () => {
    const { root, target } = await fixture();
    const outputRoot = join(root, "redirected");
    await symlink(target.workspacePath, outputRoot, "junction");
    const path = join(
      getGenUiOutputDirectory(outputRoot, {
        workspacePath: target.workspacePath,
        sessionId: target.sessionId,
      }),
      "chart.html",
    );
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "<div>Host root alias</div>");
    expect((await readGenUiDocument({ ...target, path }, outputRoot)).html).toBe(
      "<div>Host root alias</div>",
    );
  });
  it("rejects root traversal, sibling prefixes and directories", async () => {
    const { outputRoot, directory, target } = await fixture();
    for (const path of [
      join(outputRoot, "..", "chart.html"),
      join(`${outputRoot}-other`, "chart.html"),
    ]) {
      await expect(readGenUiDocument({ ...target, path }, outputRoot)).rejects.toThrow(
        "host output directory",
      );
    }
    const directoryPath = join(directory, "folder.html");
    await mkdir(directoryPath);
    await expect(readGenUiDocument({ ...target, path: directoryPath }, outputRoot)).rejects.toThrow(
      "regular file",
    );
  });
  it("rejects whole documents and files above the byte limit", async () => {
    const { outputRoot, target } = await fixture();
    await writeFile(target.path, "<!doctype html><html><body>not a fragment</body></html>");
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("fragment");
    await writeFile(target.path, "x".repeat(5_000_001));
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("5 MB");
  });
});
