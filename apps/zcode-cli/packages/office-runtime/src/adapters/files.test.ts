import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDocumentImporter } from "#office/adapters/files.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "office-import-"));
  roots.push(root);
  return { root, importer: createDocumentImporter(root) };
}
it("imports ordered chunks and keeps identical filenames independent", async () => {
  const { root, importer } = await fixture();
  try {
    const first = await importer.begin("sample.pdf", 4);
    await expect(importer.chunk(first, 2, new Uint8Array([1]))).rejects.toThrow();
    await importer.chunk(first, 0, new Uint8Array([1, 2]));
    await expect(importer.finish(first)).rejects.toThrow();
    await importer.chunk(first, 2, new Uint8Array([3, 4]));
    const path = await importer.finish(first);
    expect(path).toMatch(/^\.zcode\/document-imports\/[^/]+\/sample\.pdf$/);
    expect([...(await readFile(join(root, path)))]).toEqual([1, 2, 3, 4]);
    const second = await importer.begin("sample.pdf", 1);
    await importer.chunk(second, 0, new Uint8Array([5]));
    expect(await importer.finish(second)).not.toBe(path);
  } finally {
    await importer.close();
  }
});
it("rejects traversal and removes canceled partial imports", async () => {
  const { root, importer } = await fixture();
  await expect(importer.begin("../sample.pdf", 1)).rejects.toThrow();
  await expect(importer.begin("sample.pdf", 0)).rejects.toThrow();
  const id = await importer.begin("sample.pdf", 1);
  await importer.cancel(id);
  expect(await readdir(join(root, ".zcode/document-imports"))).toEqual([]);
  await expect(importer.finish(id)).rejects.toThrow();
  await importer.close();
});

it("serializes concurrent admission and reclaims expired slots", async () => {
  const { root } = await fixture();
  let now = Date.now();
  const importer = createDocumentImporter(root, { now: () => now });
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => importer.begin("a.pdf", 1)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
  now += 10 * 60 * 1000 + 1;
  const next = await importer.begin("b.pdf", 1);
  expect(await readdir(join(root, ".zcode/document-imports"))).toHaveLength(1);
  await importer.chunk(next, 0, new Uint8Array([1]));
  const path = await importer.finish(next);
  await importer.close();
  expect(await readFile(join(root, path))).toHaveLength(1);
});
it("startup cleans only expired partials, preserves completed and recent imports", async () => {
  const { root, importer } = await fixture();
  const parent = join(root, ".zcode/document-imports");
  for (const [name, file] of [
    ["old", ".partial"],
    ["recent", ".partial"],
    ["done", "a.pdf"],
  ]) {
    await mkdir(join(parent, name), { recursive: true });
    await writeFile(join(parent, name, file), "a");
  }
  const old = new Date(Date.now() - 11 * 60 * 1000);
  await utimes(join(parent, "old/.partial"), old, old);
  await importer.initialize();
  expect((await readdir(parent)).sort()).toEqual(["done", "recent"]);
  await importer.close();
});

it("startup does not create an import directory in a preview-only workspace", async () => {
  const { root, importer } = await fixture();
  await importer.initialize();
  expect(await readdir(root)).toEqual([]);
  await importer.close();
});
