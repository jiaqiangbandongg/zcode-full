import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@zcode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 候选目录可控：默认指向真实 monorepo（复现开发态 / 桌面态），用例按需换成临时目录。
const fakeBaseDirs = vi.hoisted(() => ({ dirs: undefined as string[] | undefined }));
vi.mock("../src/app/bundled-plugins.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app/bundled-plugins.js")>();
  return {
    ...actual,
    candidateBaseDirs: () => fakeBaseDirs.dirs ?? actual.candidateBaseDirs(),
  };
});

const {
  BUNDLED_SKILL_PACK_REQUIRED_PATHS,
  DYNAMIC_WORKFLOW_SKILL_NAME,
  SEA_BUNDLED_SKILL_ASSET_PREFIX,
  resolveBundledSkillRoots,
} = await import("../src/app/bundled-skills.js");

type SeaModuleLike = { getAsset: unknown; getRawAsset: unknown; isSea(): boolean };

const originalGetBuiltinModule = process.getBuiltinModule;

function installSea(module: SeaModuleLike | undefined): void {
  Object.defineProperty(process, "getBuiltinModule", {
    configurable: true,
    value: module
      ? (id: string) => {
          if (id === "node:sea") return module;
          return originalGetBuiltinModule(id as never);
        }
      : originalGetBuiltinModule,
    writable: true,
  });
}

function createLogger(): Logger & { warnings: Array<{ context: unknown; message: string }> } {
  const warnings: Array<{ context: unknown; message: string }> = [];
  return {
    debug() {},
    error() {},
    info() {},
    warn(message: string, context?: unknown) {
      warnings.push({ context, message });
    },
    warnings,
  } as unknown as Logger & { warnings: Array<{ context: unknown; message: string }> };
}

interface FakeSeaPack {
  files: Map<string, Buffer>;
  manifest: { files: Array<{ path: string; sha256: string }>; hash: string; version: 1 };
}

function createFakeSeaPack(
  contents: Record<string, string>,
  options: { corruptFirst?: boolean } = {},
): FakeSeaPack {
  const files = new Map<string, Buffer>();
  const manifestFiles = Object.entries(contents)
    .map(([path, text]) => {
      const bytes = Buffer.from(text);
      files.set(path, bytes);
      return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (options.corruptFirst && manifestFiles[0]) {
    // 清单声称的 hash 与资产字节不一致：解压必须拒绝，而不是落盘一个改过的技能。
    manifestFiles[0].sha256 = "0".repeat(64);
  }
  const hash = createHash("sha256")
    .update(JSON.stringify(manifestFiles.map((file) => [file.path, file.sha256])))
    .digest("hex");
  return { files, manifest: { files: manifestFiles, hash, version: 1 } };
}

function seaModuleFor(pack: FakeSeaPack): SeaModuleLike {
  return {
    getAsset: (key: string) => {
      if (key === `${SEA_BUNDLED_SKILL_ASSET_PREFIX}manifest.json`) {
        return JSON.stringify(pack.manifest);
      }
      throw new Error(`unknown asset ${key}`);
    },
    getRawAsset: (key: string) => {
      const bytes = pack.files.get(key.slice(SEA_BUNDLED_SKILL_ASSET_PREFIX.length));
      if (!bytes) throw new Error(`unknown raw asset ${key}`);
      // node:sea 的 getRawAsset 返回独占的 ArrayBuffer；Buffer 可能来自共享池，必须拷贝成精确尺寸。
      return Uint8Array.from(bytes).buffer;
    },
    isSea: () => true,
  };
}

const COMPLETE_PACK = Object.fromEntries(
  BUNDLED_SKILL_PACK_REQUIRED_PATHS.map((path) => [path, `# ${path}\n`]),
);

describe("resolveBundledSkillRoots", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-bundled-skills-"));
    fakeBaseDirs.dirs = undefined;
  });

  afterEach(async () => {
    installSea(undefined);
    fakeBaseDirs.dirs = undefined;
    await rm(tempRoot, { force: true, recursive: true });
  });

  it("finds the real pack next to the CLI sources and reads it in place", () => {
    const roots = resolveBundledSkillRoots({ cliStorageRoot: join(tempRoot, "cli") });
    expect(roots).toHaveLength(1);
    const [root] = roots;
    expect(root).toMatchObject({ scope: "system", source: "bundled" });
    expect(root?.path.endsWith(join("bundled-skills", "skills"))).toBe(true);
    expect(existsSync(join(root!.path, DYNAMIC_WORKFLOW_SKILL_NAME, "SKILL.md"))).toBe(true);
    // 非 SEA 形态不落盘：storage 里不应出现任何解压产物。
    expect(existsSync(join(tempRoot, "cli", "bundled-skills"))).toBe(false);
  });

  it("refuses a staged pack that lost a required file, and warns", async () => {
    const stagedRoot = join(tempRoot, "entry");
    await mkdir(
      join(stagedRoot, "packages", "bundled-skills", "skills", DYNAMIC_WORKFLOW_SKILL_NAME),
      {
        recursive: true,
      },
    );
    await writeFile(
      join(
        stagedRoot,
        "packages",
        "bundled-skills",
        "skills",
        DYNAMIC_WORKFLOW_SKILL_NAME,
        "SKILL.md",
      ),
      "# partial",
    );
    fakeBaseDirs.dirs = [stagedRoot];
    const logger = createLogger();

    expect(resolveBundledSkillRoots({ cliStorageRoot: join(tempRoot, "cli"), logger })).toEqual([]);
    expect(logger.warnings.map((entry) => entry.message)).toEqual([
      "Bundled skill pack unavailable",
    ]);
  });

  it("finds a complete staged pack through any candidate base directory", async () => {
    const stagedRoot = join(tempRoot, "entry");
    for (const [path, text] of Object.entries(COMPLETE_PACK)) {
      const filePath = join(stagedRoot, "packages", "bundled-skills", ...path.split("/"));
      await mkdir(join(filePath, ".."), { recursive: true });
      await writeFile(filePath, text);
    }
    fakeBaseDirs.dirs = [join(tempRoot, "nowhere"), stagedRoot];

    expect(resolveBundledSkillRoots({ cliStorageRoot: join(tempRoot, "cli") })).toEqual([
      {
        path: join(stagedRoot, "packages", "bundled-skills", "skills"),
        priority: expect.any(Number),
        scope: "system",
        source: "bundled",
      },
    ]);
  });

  describe("SEA", () => {
    it("extracts the embedded pack once into a content-hashed directory and reuses it", async () => {
      const pack = createFakeSeaPack(COMPLETE_PACK);
      installSea(seaModuleFor(pack));
      fakeBaseDirs.dirs = [join(tempRoot, "nowhere")];
      const cliStorageRoot = join(tempRoot, "cli");
      const expectedPackRoot = join(cliStorageRoot, "bundled-skills", pack.manifest.hash);

      const first = resolveBundledSkillRoots({ cliStorageRoot });
      expect(first).toEqual([
        {
          path: join(expectedPackRoot, "skills"),
          priority: expect.any(Number),
          scope: "system",
          source: "bundled",
        },
      ]);
      for (const [path, text] of Object.entries(COMPLETE_PACK)) {
        await expect(readFile(join(expectedPackRoot, ...path.split("/")), "utf8")).resolves.toBe(
          text,
        );
      }

      // 第二次启动：目录已完整，不重新解压，也不留下临时目录。
      const second = resolveBundledSkillRoots({ cliStorageRoot });
      expect(second).toEqual(first);
      const siblings = await readdir(join(cliStorageRoot, "bundled-skills"));
      expect(siblings).toEqual([pack.manifest.hash]);
    });

    it("rejects an asset whose bytes do not match the manifest and falls back to a complete older pack", async () => {
      const cliStorageRoot = join(tempRoot, "cli");
      fakeBaseDirs.dirs = [join(tempRoot, "nowhere")];

      const good = createFakeSeaPack(COMPLETE_PACK);
      installSea(seaModuleFor(good));
      const goodRoots = resolveBundledSkillRoots({ cliStorageRoot });

      const corrupt = createFakeSeaPack(
        { ...COMPLETE_PACK, [BUNDLED_SKILL_PACK_REQUIRED_PATHS[0]]: "changed" },
        {
          corruptFirst: true,
        },
      );
      installSea(seaModuleFor(corrupt));
      const logger = createLogger();

      expect(resolveBundledSkillRoots({ cliStorageRoot, logger })).toEqual(goodRoots);
      expect(logger.warnings.map((entry) => entry.message)).toEqual([
        "Bundled skill pack seed degraded",
      ]);
      expect(existsSync(join(cliStorageRoot, "bundled-skills", corrupt.manifest.hash))).toBe(false);
      const siblings = await readdir(join(cliStorageRoot, "bundled-skills"));
      expect(siblings.some((name) => name.includes(".tmp-"))).toBe(false);
    });

    it("falls through to the filesystem pack when the binary carries no bundled skill manifest", () => {
      installSea({
        getAsset: () => {
          throw new Error("no such asset");
        },
        getRawAsset: () => {
          throw new Error("no such asset");
        },
        isSea: () => true,
      });
      const roots = resolveBundledSkillRoots({ cliStorageRoot: join(tempRoot, "cli") });
      expect(roots).toHaveLength(1);
      expect(roots[0]?.path.endsWith(join("bundled-skills", "skills"))).toBe(true);
    });
  });
});
