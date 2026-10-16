import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GENERATED_LINE_COUNT = 160;

export async function prepareWorkspace(input) {
  await mkdir(input.workspace, { recursive: true });
  await cp(input.fixtureDir, input.workspace, { recursive: true });
  await mkdir(join(input.workspace, "scripts"), { recursive: true });
  const emitters = [
    ["emit-alpha.mjs", input.alphaSentinel, "alpha-marker.txt"],
    ["emit-beta.mjs", input.betaSentinel, "beta-marker.txt"],
    ["emit-auto.mjs", input.autoSentinel, "auto-marker.txt"],
  ].filter(([, sentinel]) => typeof sentinel === "string" && sentinel.length > 0);

  for (const [scriptName, sentinel, outputPath] of emitters) {
    await writeFile(join(input.workspace, "scripts", scriptName), buildEmitterScript(sentinel, outputPath));
  }
}

function buildEmitterScript(sentinel, outputPath) {
  return [
    "import { writeFileSync } from 'node:fs';",
    `const sentinel = ${JSON.stringify(sentinel)};`,
    `writeFileSync(${JSON.stringify(outputPath)}, sentinel);`,
    `for (let index = 1; index <= ${GENERATED_LINE_COUNT}; index += 1) {`,
    "  console.log(`${sentinel}: bash output line ${index}`);",
    "}",
    "",
  ].join("\n");
}
