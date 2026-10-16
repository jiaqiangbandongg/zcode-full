import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
type Sources = Record<string, string>;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function changedSourceFiles(before: Sources, after: Sources) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((file) => before[file] !== after[file])
    .sort();
}

export async function captureWorkspaceSources(repoRoot: string): Promise<Sources> {
  const { stdout } = await execute(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "packages"],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const files = [
    ...new Set(
      stdout.split("\0").filter((file) => /^packages\/[^/]+\/src\/.*\.[cm]?[jt]sx?$/u.test(file)),
    ),
  ].sort();
  const result: Sources = {};
  // 串行小文件读取控制内存；只保存指纹，不将源码或凭据复制到报告。
  for (const file of files) result[file] = hash(await readFile(join(repoRoot, file)));
  return result;
}

async function outputHashes(root: string): Promise<Sources> {
  const result: Sources = {};
  async function visit(relative: string) {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.(js|mjs|cjs|map|html|css)$/u.test(file))
        result[file] = hash(await readFile(join(root, file)));
    }
  }
  try {
    await visit("");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result;
}

export async function withE2ESourceEvidence(options: {
  freshBuild: boolean;
  captureSources: () => Promise<Sources>;
  build: () => Promise<void>;
  appOutputDir: string;
  artifactDir: string;
}) {
  const before = options.freshBuild ? await options.captureSources() : {};
  await options.build();
  const after = options.freshBuild ? await options.captureSources() : {};
  const outputs = await outputHashes(options.appOutputDir);
  const changedFiles = changedSourceFiles(before, after);
  const evidence = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    status: !options.freshBuild
      ? "unverified-reused-build"
      : changedFiles.length
        ? "source-changed-during-build"
        : Object.keys(outputs).length
          ? "fresh-stable"
          : "missing-build-output",
    domains: ["renderer", "host", "main"],
    sources: after,
    outputs,
    changedFiles,
  };
  await mkdir(options.artifactDir, { recursive: true });
  await writeFile(
    join(options.artifactDir, "build-source-evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  return evidence;
}
