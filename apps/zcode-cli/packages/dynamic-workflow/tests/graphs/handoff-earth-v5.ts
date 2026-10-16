// Hand-off graph acceptance sample (docs/dynamic-workflow/presentation.md「The display contract」):
// the earth-v5 orchestration with prompts shortened. Five phases:
//   P1 architect alone; P2 harness + a five-member builder family (literal ROLES) and no
//   hand-offs; P3 workspace ⇄ fixer (back edge); P4 workspace → {fixer, jury-a/b/c},
//   juries → polisher (types JuryVerdict), polisher →(back) workspace, fixer →(back)
//   workspace; P5 a lone workspace card.
interface Contract {
  namespace: string;
  signatureFeatures: string[];
}
interface BuildReport {
  builder: string;
  status: "done" | "blocked";
}
interface SceneScore {
  scene: string;
  score: number;
}
interface JuryVerdict {
  sceneScores: SceneScore[];
}
interface FixReport {
  summary: string;
  gatesGreenNow: boolean;
}
interface WorkflowReport {
  gatesGreen: boolean;
  visualGreen: boolean;
  signatureFeatures: string[];
}

const INTEG_ROUNDS = 4;
const VISUAL_ROUNDS = 3;
const VISUAL_PASS = 8.6;

function consolidate(verdicts: JuryVerdict[]): { scene: string; median: number }[] {
  const rows: { scene: string; median: number }[] = [];
  for (const v of verdicts) for (const ss of v.sceneScores) rows.push({ scene: ss.scene, median: ss.score });
  return rows.sort((a, b) => a.median - b.median);
}

phase("总设计");
const architect = agent("architect", { system: "总设计师" });
const contract = await architect.ask<Contract>("冻结规格与契约");
report({ stage: "contract", namespace: contract.namespace });

phase("并行构建");
const harness = agent("harness", { system: "测试基建工程师" });
const ROLES = ["data", "astro", "gl", "ui", "app"];
const parallelResults = await Promise.all([
  harness.ask<BuildReport>("写出三个工具"),
  ...ROLES.map((r) => agent(`builder-${r}`).ask<BuildReport>(`你是 builder-${r}`)),
]);
report({ stage: "build", reports: parallelResults.map((b) => b.status) });

phase("集成与门禁");
const fixer = agent("fixer", { system: "集成与修复专家" });
let gatesGreen = false;
for (let round = 1; round <= INTEG_ROUNDS && !gatesGreen; round++) {
  const asm = await world.run("node", ["tools/assemble.js"]);
  if (asm.exitCode !== 0) {
    const fix = await fixer.ask<FixReport>(`assemble.js 失败\n${asm.stderr}`);
    report({ stage: `integ-${round}`, fixed: fix.gatesGreenNow });
    continue;
  }
  const acc = await world.run("node", ["tools/accept.js"]);
  gatesGreen = acc.exitCode === 0;
  if (!gatesGreen) {
    await fixer.ask<FixReport>(`accept.js 未过\n${acc.stdout}`);
  }
}
if (!gatesGreen) {
  const failed: WorkflowReport = { gatesGreen: false, visualGreen: false, signatureFeatures: contract.signatureFeatures };
  return failed;
}

phase("视觉评审");
const juryPersona = { system: "视觉评审" } as const;
const juryA = agent("jury-a", juryPersona);
const juryB = agent("jury-b", juryPersona);
const juryC = agent("jury-c", juryPersona);
const polisher = agent("polisher", { system: "视觉精修师" });
let rows: { scene: string; median: number }[] = [];
let visualGreen = false;
let scoredDirty = false;
for (let round = 1; round <= VISUAL_ROUNDS; round++) {
  const shoot = await world.run("node", ["tools/shoot.js"]);
  if (shoot.exitCode !== 0) {
    await fixer.ask<FixReport>(`shoot.js 失败\n${shoot.stderr}`);
    continue;
  }
  const verdicts = await Promise.all([juryA, juryB, juryC].map((j) => j.ask<JuryVerdict>(`第 ${round} 轮视觉评审`)));
  rows = consolidate(verdicts);
  visualGreen = rows.length > 0 && rows.every((r) => r.median >= VISUAL_PASS);
  if (visualGreen) break;
  const below = rows.filter((r) => r.median < VISUAL_PASS);
  await polisher.ask<FixReport>(`视觉打磨 ${JSON.stringify(below)}`);
  scoredDirty = true;
}
if (scoredDirty) {
  const shoot = await world.run("node", ["tools/shoot.js"]);
  if (shoot.exitCode === 0) {
    const confirm = await juryA.ask<JuryVerdict>("终验确认");
    rows = consolidate([confirm]);
    visualGreen = rows.length > 0 && rows.every((r) => r.median >= VISUAL_PASS);
  }
}

phase("终验与交付");
const finalAsm = await world.run("node", ["tools/assemble.js"]);
const finalAcc = await world.run("node", ["tools/accept.js"]);
const finalReport: WorkflowReport = {
  gatesGreen: finalAsm.exitCode === 0 && finalAcc.exitCode === 0,
  visualGreen,
  signatureFeatures: contract.signatureFeatures,
};
return finalReport;
