import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  chmod,
  stat,
  rename,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUserSubagentMarkdown } from "../src/node/subagentMarkdownMigration.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});

const old =
  "---\nname: helper\ndescription: test\nmodel: builtin:bigmodel-coding-plan/GLM\nthoughtLevel: high\n---\n正文\n";
const current = old.replace(
  "model: builtin:bigmodel-coding-plan",
  "model: account:bigmodel-individual-coding-plan",
);
const dirs: string[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile);
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sa97-"));
  dirs.push(root);
  const user = join(root, "user", "agents");
  const project = join(root, "project", ".zcode", "agents");
  await mkdir(user, { recursive: true });
  await mkdir(project, { recursive: true });
  return { root, user, project };
}
describe("仅用户目录的异步 Markdown 迁移", () => {
  it("写入失败不伪造完成，下次加载可重试且无临时文件", async () => {
    const { user } = await fixture();
    const file = join(user, "helper.md");
    await writeFile(file, old);
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    const failed = await migrateUserSubagentMarkdown(user);
    expect(failed.failures).toHaveLength(1);
    expect(failed.migrated).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(old);
    expect(await readdir(user)).toEqual(["helper.md"]);
    expect((await migrateUserSubagentMarkdown(user)).migrated).toEqual([file]);
  });
  it("临时文件准备期间用户编辑，写前比较保留用户新内容", async () => {
    const { user } = await fixture();
    const file = join(user, "helper.md");
    await writeFile(file, old);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const edited = old.replace("GLM", "USER-EDIT");
    // 锁元数据也会 writeFile；只在迁移临时文件写入后注入编辑。
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      await actual.writeFile(...args);
      if (String(args[0]).endsWith(".tmp")) await actual.writeFile(file, edited);
    });
    const result = await migrateUserSubagentMarkdown(user);
    expect(result.failures).toHaveLength(1);
    expect(result.migrated).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(edited);
  });
  it("只改用户文件，保留模式，重启幂等且后来加入的旧文件可迁", async () => {
    const { user, project } = await fixture();
    const file = join(user, "helper.md");
    const other = join(project, "helper.md");
    await writeFile(file, old);
    await chmod(file, 0o640);
    // Windows chmod 仅映射只读属性；验证实际模式被保留，POSIX 仍严格检查指定权限。
    const originalMode = (await stat(file)).mode & 0o777;
    if (process.platform !== "win32") expect(originalMode).toBe(0o640);
    await writeFile(other, old);
    expect((await migrateUserSubagentMarkdown(user)).migrated).toEqual([file]);
    expect(await readFile(file, "utf8")).toBe(current);
    expect((await stat(file)).mode & 0o777).toBe(originalMode);
    expect(await readFile(other, "utf8")).toBe(old);
    expect((await migrateUserSubagentMarkdown(user)).migrated).toEqual([]);
    await writeFile(join(user, "later.md"), old);
    expect((await migrateUserSubagentMarkdown(user)).migrated).toEqual([join(user, "later.md")]);
  });
  // Windows 普通用户无符号链接权限（需开发者模式），fs.symlink EPERM；覆盖由 CI Linux 承担。
  it.skipIf(process.platform === "win32")(
    "不跟随链接、不改只读文件；其他可迁文件继续",
    async () => {
      const { user, project } = await fixture();
      const other = join(project, "outside.md");
      await writeFile(other, old);
      await symlink(other, join(user, "link.md"));
      await symlink(project, join(user, "linked-dir"));
      const readonly = join(user, "readonly.md");
      await writeFile(readonly, old);
      await chmod(readonly, 0o400);
      const originalMode = (await stat(readonly)).mode & 0o777;
      expect(originalMode).toBe(0o400);
      await writeFile(join(user, "good.md"), old);
      const outcome = await migrateUserSubagentMarkdown(user);
      expect(outcome.migrated).toEqual([join(user, "good.md")]);
      expect(await readFile(other, "utf8")).toBe(old);
      expect(await readFile(readonly, "utf8")).toBe(old);
      expect((await stat(readonly)).mode & 0o777).toBe(originalMode);
    },
  );
  it("并发初始化不会重复覆盖，缺少目录不创建", async () => {
    const { user, root } = await fixture();
    const file = join(user, "helper.md");
    await writeFile(file, old);
    const results = await Promise.all([
      migrateUserSubagentMarkdown(user),
      migrateUserSubagentMarkdown(user),
    ]);
    expect(results.flatMap((result) => result.migrated)).toEqual([file]);
    expect(await readFile(file, "utf8")).toBe(current);
    expect(await migrateUserSubagentMarkdown(join(root, "missing"))).toEqual({
      migrated: [],
      failures: [],
    });
  });
});
