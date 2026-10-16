#!/usr/bin/env node

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  FAKE_CASE_NAMES,
  REAL_CASE_NAMES,
} from "./constants.mjs";
import { parseArgs, resolveCaseNames } from "./args.mjs";
import { writeJsonFile } from "./artifacts.mjs";
import { formatError } from "./diagnostics.mjs";
import { loadZCodeModules } from "./case-utils.mjs";
import { getCaseDefinitions } from "./suite-cases.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const fixtureDir = join(scriptDir, "fixture", "repo");

async function main() {
  const rawOptions = parseArgs(process.argv.slice(2));
  const selectedCaseNames = resolveCaseNames(rawOptions.cases);
  const options = {
    ...rawOptions,
    baseURL: rawOptions.baseURL ?? DEFAULT_BASE_URL,
    model: rawOptions.model ?? DEFAULT_MODEL,
  };
  const runRoot = await mkdtemp(join(tmpdir(), "zcode-compact-e2e-"));
  const artifactsRoot = options.artifactsDir ? resolve(options.artifactsDir) : runRoot;
  const resultPath = join(artifactsRoot, "result.json");
  const eventsIndexPath = join(artifactsRoot, "events.json");
  const captureIndexPath = join(artifactsRoot, "capture.json");
  let keepTmp = options.keepTmp;

  try {
    await mkdir(artifactsRoot, { recursive: true });
    const caseDefinitions = getCaseDefinitions(selectedCaseNames);
    if (options.dryRun) {
      await writeDryRun({
        artifactsRoot,
        caseDefinitions,
        resultPath,
        selectedCaseNames,
        options,
      });
      return;
    }

    if (caseDefinitions.some((caseDef) => caseDef.requiresApiKey) && !process.env.ZCODE_API_KEY) {
      keepTmp = true;
      throw new Error(
        "ZCODE_API_KEY is required for real-provider compact E2E cases. Use --case=fake to run only local scripted cases.",
      );
    }

    const modules = await loadZCodeModules(repoRoot);
    const caseResults = [];
    for (const caseDef of caseDefinitions) {
      const caseRoot = join(runRoot, "cases", caseDef.name);
      try {
        const caseResult = await caseDef.run({
          artifactsRoot,
          caseName: caseDef.name,
          caseRoot,
          fixtureDir,
          modules,
          options,
          repoRoot,
        });
        caseResults.push(caseResult);
        console.log(JSON.stringify({ case: caseDef.name, status: "passed" }));
      } catch (error) {
        keepTmp = true;
        const failure = {
          case: caseDef.name,
          error: formatError(error),
          model: caseDef.model,
          status: "failed",
        };
        caseResults.push(failure);
        console.error(JSON.stringify(failure, null, 2));
      }
    }

    const suiteResult = buildSuiteResult(caseResults, {
      artifactsRoot,
      captureIndexPath,
      eventsIndexPath,
      model: `${DEFAULT_PROVIDER}/${options.model}`,
      resultPath,
      selectedCaseNames,
    });
    await writeJsonFile(resultPath, suiteResult);
    await writeJsonFile(eventsIndexPath, buildArtifactIndex(caseResults, "eventsPath"));
    await writeJsonFile(captureIndexPath, buildArtifactIndex(caseResults, "capturePath"));
    console.log(JSON.stringify(suiteResult, null, 2));

    if (suiteResult.status !== "passed") {
      process.exitCode = 1;
    }
  } catch (error) {
    keepTmp = true;
    const failure = {
      artifactsRoot,
      error: formatError(error),
      resultPath,
      status: "failed",
    };
    await mkdir(artifactsRoot, { recursive: true });
    await writeJsonFile(resultPath, failure);
    console.error("Compact E2E suite failed.");
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  } finally {
    if (!keepTmp) {
      await rm(runRoot, { force: true, recursive: true });
    } else {
      console.error(`Temporary workspace kept at: ${runRoot}`);
    }
  }
}

async function writeDryRun(input) {
  const defaultModel = `${DEFAULT_PROVIDER}/${input.options.model}`;
  const reportedModel =
    input.caseDefinitions.length === 1
      ? (input.caseDefinitions[0]?.model ?? defaultModel)
      : defaultModel;
  const payload = {
    artifactsDir: input.artifactsRoot,
    baseURL: input.options.baseURL,
    cases: input.selectedCaseNames,
    dryRun: true,
    fakeCases: FAKE_CASE_NAMES,
    model: reportedModel,
    realCases: REAL_CASE_NAMES,
    resultPath: input.resultPath,
    status: "ok",
  };
  await writeJsonFile(input.resultPath, payload);
  console.log(JSON.stringify(payload, null, 2));
}

function buildSuiteResult(caseResults, input) {
  const failed = caseResults.filter((result) => result.status !== "passed");
  const reportedModel =
    caseResults.length === 1 ? (caseResults[0]?.model ?? input.model) : input.model;
  return {
    artifactsRoot: input.artifactsRoot,
    captureIndexPath: input.captureIndexPath,
    caseCount: caseResults.length,
    cases: caseResults.map((result) => ({
      capturedProviderRequestCount: result.capturedProviderRequestCount,
      case: result.case,
      capturePath: result.capturePath,
      eventsPath: result.eventsPath,
      model: result.model,
      resultPath: result.resultPath,
      status: result.status,
      traceId: result.traceId,
    })),
    eventsIndexPath: input.eventsIndexPath,
    failedCaseCount: failed.length,
    model: reportedModel,
    resultPath: input.resultPath,
    selectedCases: input.selectedCaseNames,
    status: failed.length === 0 ? "passed" : "failed",
  };
}

function buildArtifactIndex(caseResults, key) {
  return {
    cases: caseResults.map((result) => ({
      case: result.case,
      path: result[key],
      status: result.status,
    })),
    generatedAt: new Date().toISOString(),
  };
}

await main();
