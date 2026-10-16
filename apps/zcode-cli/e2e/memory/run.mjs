#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  startScriptedProvider,
  stopScriptedProvider,
  writeScriptedCaptureFile,
} from "../compact-microcompact/scripted-provider.mjs";
import { verifyMemoryE2EEvidence, writeMemoryE2EArtifacts } from "./memory-e2e-evidence.mjs";
import {
  createMemoryExtractionCloseBarrier,
  createProviderHandler,
} from "./memory-e2e-provider.mjs";
import {
  createScenarioPaths,
  loadZCodeModules,
  runMemoryScenarios,
} from "./memory-e2e-runtime.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifactsRoot = options.artifacts
    ? resolve(options.artifacts)
    : await mkdtemp(join(tmpdir(), "zcode-memory-e2e-artifacts-"));
  const runRoot = await mkdtemp(join(tmpdir(), "zcode-memory-e2e-run-"));
  await mkdir(artifactsRoot, { recursive: true });

  const modules = await loadZCodeModules();
  const retrievalBranch =
    modules.projectMemoryRetrievalBranch.ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH;
  const paths = await createScenarioPaths(runRoot, modules);
  const closeBarrier = createMemoryExtractionCloseBarrier();
  const provider = await startScriptedProvider({
    name: "memory-e2e",
    handler: createProviderHandler({ closeBarrier, paths, retrievalBranch }),
  });

  try {
    const scenarioResults = await runMemoryScenarios({
      closeBarrier,
      modules,
      paths,
      provider,
    });
    const evidence = await verifyMemoryE2EEvidence({
      paths,
      provider,
      retrievalBranch,
      scenarioResults,
    });
    const result = {
      artifactsRoot,
      assertions: evidence.assertions,
      categoryCounts: evidence.categoryCounts,
      retrievalBranch,
      status: "passed",
    };

    await writeMemoryE2EArtifacts({ artifactsRoot, evidence, paths, provider, result });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const result = {
      artifactsRoot,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      status: "failed",
    };
    await writeFile(join(artifactsRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    await writeScriptedCaptureFile(provider, join(artifactsRoot, "provider-capture.json"));
    throw error;
  } finally {
    await stopScriptedProvider(provider);
    if (!options.keepRunRoot) {
      await rm(runRoot, { force: true, recursive: true });
    } else {
      console.error(`Memory E2E run root kept at: ${runRoot}`);
    }
  }
}

function parseArgs(args) {
  const result = { artifacts: undefined, keepRunRoot: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--artifacts") {
      result.artifacts = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--keep-run-root") {
      result.keepRunRoot = true;
      continue;
    }
    throw new Error(`Unknown Memory E2E argument: ${arg}`);
  }
  return result;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
