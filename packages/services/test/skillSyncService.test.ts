import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SKILL_SCAN_DEPTH, SKILL_SYNC_SIZE_LIMIT_ERROR_CODE } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillSyncService } from "../src/skill-sync/skillSyncService.js";

async function symlinkSkillDirectory(target: string, linkPath: string) {
  // 修复原因：Windows 普通目录 symlink 依赖开发者模式或管理员权限，CI/本机 pre-push
  // 可能直接 EPERM；junction 能覆盖同样的 realpath 去重语义且不需要额外权限。
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function makeHome() {
  return mkdtempSync(join(tmpdir(), "zcode-skill-sync-home-"));
}

async function writeSkill(
  home: string,
  directoryName: string,
  name = directoryName,
  root: ".zcode" | ".agents" = ".zcode",
) {
  const dir = join(home, root, "skills", directoryName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} desc\n---\nBody`,
  );
  return dir;
}

async function writeBareSkill(
  home: string,
  directoryName: string,
  root: ".zcode" | ".agents" = ".zcode",
) {
  const dir = join(home, root, "skills", directoryName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "Body");
  return dir;
}

describe("skill sync service", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("lists local user zcode skills as candidates", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeSkill(home, "review");
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listLocalUserSkillCandidates();

    expect(result.candidates).toMatchObject([
      {
        name: "review",
        directoryName: "review",
        description: "review desc",
      },
    ]);
  });

  it("checks remote skill root write access before sync", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.checkRemoteUserSkillWriteAccess();

    expect(result).toMatchObject({
      ok: true,
      path: join(remoteHome, ".zcode", "skills"),
    });
  });

  it("reports remote skill write preflight failure when the target is not a directory", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await mkdir(join(remoteHome, ".zcode"), { recursive: true });
    await writeFile(join(remoteHome, ".zcode", "skills"), "not a directory");
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.checkRemoteUserSkillWriteAccess();

    expect(result.ok).toBe(false);
    expect(result.path).toBe(join(remoteHome, ".zcode", "skills"));
    expect(result.error).toBeTruthy();
  });

  it("lists local user agents skills as candidates when zcode skills are empty", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeSkill(home, "lark-doc", "lark-doc", ".agents");
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listLocalUserSkillCandidates();

    expect(result.candidates).toMatchObject([
      {
        name: "lark-doc",
        directoryName: "lark-doc",
        description: "lark-doc desc",
        path: join(home, ".agents", "skills", "lark-doc", "SKILL.md"),
      },
    ]);
  });

  it("does not list skills beyond the shared scan depth limit", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const deepPath = Array.from(
      { length: MAX_SKILL_SCAN_DEPTH + 2 },
      (_, index) => `level-${index}`,
    ).join("/");
    await writeSkill(home, `${deepPath}/too-deep`);
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listLocalUserSkillCandidates();

    expect(result.candidates.map((candidate) => candidate.directoryName)).not.toContain(
      `${deepPath}/too-deep`,
    );
  });

  it("deduplicates agents skills already covered by zcode skills", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeSkill(home, "review-zcode", "review", ".zcode");
    await writeSkill(home, "review-agents", "review", ".agents");
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listLocalUserSkillCandidates();

    expect(result.candidates.map((candidate) => candidate.directoryName)).toEqual([
      "review-zcode",
    ]);
  });

  it("deduplicates agents skills already covered by zcode symlink realpath", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const sourceDir = await writeBareSkill(home, "external-source", ".agents");
    const zcodeRoot = join(home, ".zcode", "skills");
    await mkdir(zcodeRoot, { recursive: true });
    await symlinkSkillDirectory(sourceDir, join(zcodeRoot, "linked-external"));
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listLocalUserSkillCandidates();

    expect(result.candidates.map((candidate) => candidate.directoryName)).toEqual([
      "linked-external",
    ]);
  });

  it("deduplicates agents skills covered by raw zcode directory names before realpath de-dupe", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const sourceDir = join(home, "external-source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "Body");
    const zcodeRoot = join(home, ".zcode", "skills");
    await mkdir(zcodeRoot, { recursive: true });
    await symlinkSkillDirectory(sourceDir, join(zcodeRoot, "aaa-link"));
    await symlinkSkillDirectory(sourceDir, join(zcodeRoot, "agents-only"));
    await writeBareSkill(home, "agents-only", ".agents");
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listLocalUserSkillCandidates();

    expect(result.candidates.map((candidate) => candidate.directoryName)).toEqual([
      "aaa-link",
    ]);
  });

  it("exports nested agents skills preserving their relative directory path", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeSkill(localHome, "group/review", "review", ".agents");
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const candidates = await localService.listLocalUserSkillCandidates();

    expect(candidates.candidates.map((candidate) => candidate.directoryName)).toEqual([
      "group/review",
    ]);

    const archive = await localService.exportSkillsArchive({
      skillIds: candidates.candidates.map((candidate) => candidate.id),
    });
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await remoteService.importSkillsArchive({ archive: archive.archive });

    expect(result.results[0]).toMatchObject({
      directoryName: "group/review",
      status: "synced",
    });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "group", "review", "SKILL.md"), "utf-8"),
    ).resolves.toContain("name: review");
  });

  it("exports zcode skill directory symlinks as regular remote skill directories", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const sourceDir = await writeSkill(localHome, "external-source", "external", ".agents");
    const zcodeRoot = join(localHome, ".zcode", "skills");
    await mkdir(zcodeRoot, { recursive: true });
    await symlinkSkillDirectory(sourceDir, join(zcodeRoot, "linked-external"));
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const candidates = await localService.listLocalUserSkillCandidates();

    expect(candidates.candidates).toMatchObject([
      {
        name: "external",
        directoryName: "linked-external",
        path: join(zcodeRoot, "linked-external", "SKILL.md"),
      },
    ]);

    const archive = await localService.exportSkillsArchive({
      skillIds: candidates.candidates.map((candidate) => candidate.id),
    });
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await remoteService.importSkillsArchive({ archive: archive.archive });

    expect(result.results[0]).toMatchObject({
      directoryName: "linked-external",
      status: "synced",
    });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "linked-external", "SKILL.md"), "utf-8"),
    ).resolves.toContain("name: external");
  });

  it("imports missing skills and skips existing directory names", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeSkill(localHome, "review");
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const candidates = await localService.listLocalUserSkillCandidates();
    const archive = await localService.exportSkillsArchive({
      skillIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeSkill(remoteHome, "existing");
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const first = await remoteService.importSkillsArchive({ archive: archive.archive });
    const second = await remoteService.importSkillsArchive({ archive: archive.archive });

    expect(first.results[0]).toMatchObject({ directoryName: "review", status: "synced" });
    expect(second.results[0]).toMatchObject({ directoryName: "review", status: "skipped" });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "review", "SKILL.md"), "utf-8"),
    ).resolves.toContain("name: review");
  });

  it("marks remote skills as existing when the skill name already exists in another directory", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeSkill(remoteHome, "remote-review-copy", "review");
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const status = await remoteService.listRemoteUserSkillStatuses({
      directoryNames: ["review"],
      skills: [{ directoryName: "review", name: "review" }],
    });

    expect(status.statuses).toEqual([
      {
        directoryName: "review",
        exists: true,
        path: join(remoteHome, ".zcode", "skills", "remote-review-copy"),
      },
    ]);
  });

  it("marks remote agents skills as existing when the same skill name exists there", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeSkill(remoteHome, "agents-review-copy", "review", ".agents");
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const status = await remoteService.listRemoteUserSkillStatuses({
      directoryNames: ["review"],
      skills: [{ directoryName: "review", name: "review" }],
    });

    expect(status.statuses).toEqual([
      {
        directoryName: "review",
        exists: true,
        path: join(remoteHome, ".agents", "skills", "agents-review-copy"),
      },
    ]);
  });

  it("rejects remote status directory names that escape the skill root", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await mkdir(join(remoteHome, ".ssh"), { recursive: true });
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    await expect(
      remoteService.listRemoteUserSkillStatuses({
        directoryNames: ["../../.ssh"],
      }),
    ).rejects.toThrow("unsafe skill sync path");
  });

  it("rejects remote status skill metadata directory names that escape the skill root", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    await expect(
      remoteService.listRemoteUserSkillStatuses({
        directoryNames: ["review"],
        skills: [{ directoryName: "../review", name: "review" }],
      }),
    ).rejects.toThrow("unsafe skill sync path");
  });

  it("skips imports when the remote already has the same skill name in another directory", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeSkill(localHome, "local-review", "review");
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const candidates = await localService.listLocalUserSkillCandidates();
    const archive = await localService.exportSkillsArchive({
      skillIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeSkill(remoteHome, "remote-review-copy", "review");
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await remoteService.importSkillsArchive({ archive: archive.archive });

    expect(result.results[0]).toMatchObject({
      directoryName: "local-review",
      status: "skipped",
      path: join(remoteHome, ".zcode", "skills", "remote-review-copy"),
    });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "local-review", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();
  });

  it("skips imports when the remote agents root already has the same skill name", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeSkill(localHome, "local-review", "review");
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const candidates = await localService.listLocalUserSkillCandidates();
    const archive = await localService.exportSkillsArchive({
      skillIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeSkill(remoteHome, "agents-review-copy", "review", ".agents");
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await remoteService.importSkillsArchive({ archive: archive.archive });

    expect(result.results[0]).toMatchObject({
      directoryName: "local-review",
      status: "skipped",
      path: join(remoteHome, ".agents", "skills", "agents-review-copy"),
    });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "local-review", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();
  });

  it("rejects export when selected skill content exceeds the sync size limit before gzip", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const skillDir = await writeSkill(home, "large-skill");
    await writeFile(join(skillDir, "large.txt"), "a".repeat(4096));
    const service = createSkillSyncService({ maxArchiveBytes: 1024 });
    const candidates = await service.listLocalUserSkillCandidates();

    await expect(
      service.exportSkillsArchive({
        skillIds: candidates.candidates.map((candidate) => candidate.id),
      }),
    ).rejects.toMatchObject({
      code: SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
      data: {
        actualBytes: expect.any(Number),
        maxBytes: 1024,
        phase: "selected-content",
      },
    });
  });

  it("rejects import when extracted skill content exceeds the sync size limit", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    const skillDir = await writeSkill(localHome, "large-skill");
    await writeFile(join(skillDir, "large.txt"), "a".repeat(4096));
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const candidates = await localService.listLocalUserSkillCandidates();
    const archive = await localService.exportSkillsArchive({
      skillIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 });

    await expect(
      remoteService.importSkillsArchive({ archive: archive.archive }),
    ).rejects.toMatchObject({
      code: SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
      data: {
        actualBytes: expect.any(Number),
        maxBytes: 1024,
        phase: "extracted-content",
      },
    });
    await expect(
      readFile(join(remoteHome, ".zcode", "skills", "large-skill", "large.txt"), "utf-8"),
    ).rejects.toThrow();
  });
});
