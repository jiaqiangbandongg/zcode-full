import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Writable } from "node:stream";
import type { RunSummary } from "../shared/types.js";

export const DATA_DIR_NAME = ".stream-animate-data";

export function createRunId(now = new Date()) {
  const stamp = now.toISOString().replaceAll(/[-:.TZ]/gu, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export function getDataDir(packageRoot: string) {
  return join(packageRoot, DATA_DIR_NAME);
}

export function getRunDir(packageRoot: string, runId: string) {
  return join(getDataDir(packageRoot), "runs", runId.slice(0, 8), runId);
}

export async function ensureRunDir(packageRoot: string, runId: string) {
  const runDir = getRunDir(packageRoot, runId);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

export function createRawWriter(runDir: string) {
  const rawPath = join(runDir, "raw.ndjson");
  const stream = createWriteStream(rawPath, { encoding: "utf-8", flags: "a" });
  return {
    path: rawPath,
    write(record: unknown) {
      stream.write(`${JSON.stringify(record)}\n`);
    },
    close: () => closeStream(stream),
  };
}

export async function writeRunSummary(runDir: string, summary: RunSummary) {
  await writeJson(join(runDir, "summary.json"), summary);
}

export async function writeResponseText(runDir: string, responseText: string) {
  await writeFile(join(runDir, "response.txt"), responseText, "utf-8");
}

export async function listRuns(packageRoot: string) {
  const runsRoot = join(getDataDir(packageRoot), "runs");
  const summaryPaths = await collectSummaryPaths(runsRoot);
  const runs = await Promise.all(
    summaryPaths.map(async (summaryPath) => JSON.parse(await readFile(summaryPath, "utf-8")) as RunSummary),
  );
  return runs.sort((first, second) => second.createdAt.localeCompare(first.createdAt));
}

export async function readRun(packageRoot: string, runId: string) {
  const summaryPath = join(getRunDir(packageRoot, runId), "summary.json");
  return JSON.parse(await readFile(summaryPath, "utf-8")) as RunSummary;
}

export async function readRawLines(packageRoot: string, runId: string, limit: number) {
  const rawPath = join(getRunDir(packageRoot, runId), "raw.ndjson");
  const text = await readFile(rawPath, "utf-8");
  return text.split(/\r?\n/u).filter(Boolean).slice(-limit);
}

export function toDataRelativePath(packageRoot: string, filePath: string) {
  return relative(getDataDir(packageRoot), filePath);
}

async function collectSummaryPaths(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const paths = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(root, entry.name);
      if (entry.isDirectory()) {
        return collectSummaryPaths(entryPath);
      }
      return entry.name === "summary.json" ? [entryPath] : [];
    }),
  );
  return paths.flat();
}

async function writeJson(path: string, body: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
}

async function closeStream(stream: Writable) {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}
