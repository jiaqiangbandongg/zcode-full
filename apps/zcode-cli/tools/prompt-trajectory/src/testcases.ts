import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadFixture, type PromptTrajectoryFixture } from "./fixture.js";
import { recordPromptTrajectoryFromFixture } from "./record.js";

export interface PromptTrajectoryCase {
  directory: string;
  expectPath: string;
  fixturePath?: string;
  name: string;
  promptPath?: string;
}

export interface SharedModelOptions {
  apiKey?: string;
  apiKeyEnv?: string;
  modelId?: string;
  upstreamBaseURL?: string;
}

export async function discoverPromptTrajectoryCases(
  casesDir: string,
): Promise<PromptTrajectoryCase[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  const cases: PromptTrajectoryCase[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(casesDir, entry.name);
    const promptPath = join(directory, "prompt.txt");
    const fixturePath = join(directory, "fixture.json");
    const expectPath = join(directory, "expect.json");
    if (!(await fileExists(expectPath))) continue;
    const hasPrompt = await fileExists(promptPath);
    const hasFixture = await fileExists(fixturePath);
    if (!hasPrompt && !hasFixture) continue;
    cases.push({
      directory,
      expectPath,
      ...(hasFixture ? { fixturePath } : {}),
      name: entry.name,
      ...(hasPrompt ? { promptPath } : {}),
    });
  }

  return cases.sort((left, right) => left.name.localeCompare(right.name));
}

export async function createTimestampedRunDirectory(
  outRoot: string,
  now = new Date(),
): Promise<string> {
  const directory = join(outRoot, `test${formatTimestamp(now)}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function createTimestampedPromptDirectory(
  outRoot: string,
  now = new Date(),
): Promise<string> {
  const directory = join(outRoot, `prompt${formatTimestamp(now)}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function promptFixtureFromCase(
  testcase: PromptTrajectoryCase,
  modelOptions?: SharedModelOptions,
): Promise<PromptTrajectoryFixture> {
  if (testcase.fixturePath) {
    const fixture = await loadFixture(testcase.fixturePath);
    return mergeFixtureModelOptions(fixture, modelOptions);
  }
  if (!testcase.promptPath) {
    throw new Error(`Prompt trajectory case ${testcase.name} is missing prompt.txt or fixture.json`);
  }
  return promptFixtureFromText({
    modelOptions,
    name: testcase.name,
    prompt: await readFile(testcase.promptPath, "utf8"),
  });
}

function mergeFixtureModelOptions(
  fixture: PromptTrajectoryFixture,
  modelOptions?: SharedModelOptions,
): PromptTrajectoryFixture {
  const model = createFixtureModel(modelOptions);
  const merged = {
    ...fixture,
    ...(model
      ? {
          model: {
            ...fixture.model,
            ...model,
          },
        }
      : {}),
  };
  requireExplicitModel(merged.model);
  return merged;
}

export function promptFixtureFromText(input: {
  modelOptions?: SharedModelOptions;
  name: string;
  prompt: string;
}): PromptTrajectoryFixture {
  const model = createFixtureModel(input.modelOptions);
  requireExplicitModel(model);

  return {
    model,
    name: input.name,
    runtimeConfig: {
      mode: "yolo",
      modelStreaming: "on",
    },
    steps: [
      {
        text: input.prompt,
        type: "submitPrompt",
      },
    ],
  };
}

function requireExplicitModel(
  model: PromptTrajectoryFixture["model"] | undefined,
): asserts model is NonNullable<PromptTrajectoryFixture["model"]> {
  const hasIdentity = Boolean(model?.id || (model?.provider && model.model));
  if (!hasIdentity || !model?.upstreamBaseURL) {
    throw new Error(
      "Explicit model options are required: provide provider/model and upstreamBaseURL.",
    );
  }
}

export async function runPromptTrajectoryCases(input: {
  casesDir: string;
  modelOptions?: SharedModelOptions;
  outRoot: string;
}): Promise<{
  caseCount: number;
  runDir: string;
}> {
  const cases = await discoverPromptTrajectoryCases(input.casesDir);
  if (cases.length === 0) {
    throw new Error(`No prompt trajectory cases found in ${input.casesDir}`);
  }

  const runDir = await createTimestampedRunDirectory(input.outRoot);
  for (const testcase of cases) {
    const caseOutDir = join(runDir, sanitizeCaseName(testcase.name));
    await mkdir(caseOutDir, { recursive: true });
    await copyFile(testcase.expectPath, join(caseOutDir, "expect.json"));
    await recordPromptTrajectoryFromFixture({
      fixture: await promptFixtureFromCase(testcase, input.modelOptions),
      outDir: caseOutDir,
    });
  }

  return {
    caseCount: cases.length,
    runDir,
  };
}

function createFixtureModel(
  modelOptions: SharedModelOptions | undefined,
): PromptTrajectoryFixture["model"] | undefined {
  if (!modelOptions) return undefined;
  const model: PromptTrajectoryFixture["model"] = {};
  if (modelOptions.modelId !== undefined) {
    model.id = modelOptions.modelId;
  }
  if (modelOptions.upstreamBaseURL !== undefined) {
    model.upstreamBaseURL = modelOptions.upstreamBaseURL;
  }
  if (modelOptions.apiKey !== undefined) {
    model.apiKey = modelOptions.apiKey;
  }
  if (modelOptions.apiKeyEnv !== undefined) {
    model.apiKeyEnv = modelOptions.apiKeyEnv;
  }
  if (Object.keys(model).length === 0) return undefined;
  model.kind = "openai-compatible";
  return model;
}

function formatTimestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function sanitizeCaseName(name: string): string {
  const sanitized = basename(name).replace(/[^a-zA-Z0-9._-]+/gu, "_");
  return sanitized.length > 0 ? sanitized : "case";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
