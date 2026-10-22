import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import config from "../../../lint-staged.config.mjs";

const manifests: string[] = [];
afterEach(async () => {
  await Promise.all(manifests.splice(0).map((path) => rm(path, { force: true })));
});
async function manifestFor(files: string[]) {
  const callbacks = Object.values(config);
  expect(callbacks).toHaveLength(1);
  const command = await callbacks[0]!(files);
  expect(typeof command).toBe("string");
  const path = String(command)
    .match(/--files-manifest\s+(.+)$/u)![1]!
    .replace(/^['"]|['"]$/gu, "");
  manifests.push(path);
  return { command, path, manifest: JSON.parse(await readFile(path, "utf8")) };
}

describe("lint-staged affected 入口", () => {
  it("源码、测试和重复输入进入同一清单，由选择器统一去重执行", async () => {
    const files = ["packages/ui/src/a.ts", "packages/ui/test/a.test.ts", "packages/ui/src/a.ts"];
    const { manifest, path } = await manifestFor(files);
    expect(manifest).toEqual({ mode: "affected", files: files.slice(0, 2) });
    expect(dirname(path)).toBe(resolve(tmpdir()));
  });
  it("文件名中的 Windows shell 字符只存在于 JSON，不拼进命令", async () => {
    const file = "packages/ui/src/foo%PATH% caret^ amp& paren(x).ts";
    const { command, manifest } = await manifestFor([file]);
    expect(command).not.toContain(file);
    expect(manifest.files).toEqual([file]);
  });
  it("空清单和 E2E-only 不启动根单测", async () => {
    const callback = Object.values(config)[0]!;
    expect(await callback([])).toEqual([]);
    expect(await callback(["packages\\desktop\\test\\e2e\\example.test.ts"])).toEqual([]);
  });
});
