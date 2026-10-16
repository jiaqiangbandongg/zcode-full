// The jsonl-db optimization loop, condensed: the motivating example for phase markers
// (docs/dynamic-workflow/presentation.md「The display contract」). Six markers turn a
// dense step graph into preflight → attempt → gate → checkpoint/recover → wrap-up.
//
// Three things this fixture exists to pin: the shared `runBench` helper is claimed by
// BOTH preflight and gate, so its site is copied once per phase; the gate's `continue`
// exits mean the phases cannot be expressed as scope callbacks (which is why markers are
// statements); and the loop closes with cross-phase carries rather than a container.

interface Attempt {
  /** One sentence: the optimization increment this attempt implements. */
  approach: string;
}

interface Advice {
  /** 2-4 sentences: a different, concrete strategy for the next iteration. */
  strategy: string;
}

/** One bench run. Called from preflight (baseline) and from the gate (candidate). */
async function runBench(): Promise<number> {
  const bench = await world.run("./target/release/bench", []);
  return bench.exitCode === 0 ? Number(bench.stdout.trim()) : Number.MAX_SAFE_INTEGER;
}

phase("preflight");
const status = await world.run("git", ["status", "--porcelain"]);
if (status.stdout.trim() !== "") throw new Error("working tree is not clean");
const build = await world.run("cargo", ["build", "--release"]);
if (build.exitCode !== 0) throw new Error(`baseline build failed:\n${build.stderr}`);
let bestMs = await runBench();

const optimizer = agent("optimizer", { system: "You make the engine faster." });
const consultant = agent("consultant", { system: "You propose another angle." });

let feedback = "Fresh run: take the biggest structural lever.";
for (let iter = 0; iter < 4; iter++) {
  let accepted = false;
  for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
    phase("attempt");
    const plan = await optimizer.ask<Attempt>(`Attempt ${attempt}. Feedback:\n${feedback}`);

    phase("gate");
    const tests = await world.run("cargo", ["test"]);
    if (tests.exitCode !== 0) {
      feedback = `"${plan.approach}" broke the tests:\n${tests.stderr}`;
      continue;
    }
    const candMs = await runBench();
    if (candMs < bestMs) {
      phase("checkpoint");
      const commit = await world.run("git", ["commit", "-am", `perf: ${plan.approach}`]);
      if (commit.exitCode !== 0) throw new Error(`checkpoint failed:\n${commit.stderr}`);
      bestMs = candMs;
      feedback = `Accepted "${plan.approach}" at ${bestMs} ms.`;
      accepted = true;
    } else {
      feedback = `"${plan.approach}" was not faster: ${candMs} vs ${bestMs} ms.`;
    }
  }
  if (accepted) {
    report({ bestMs, iter });
  } else {
    phase("recover");
    const rollback = await world.run("git", ["reset", "--hard", "HEAD"]);
    if (rollback.exitCode !== 0) throw new Error("rollback failed");
    const advice = await consultant.ask<Advice>(`Iteration ${iter} was rejected:\n${feedback}`);
    feedback = `Take a different angle: ${advice.strategy}`;
  }
}

phase("wrap-up");
const head = await world.run("git", ["rev-parse", "HEAD"]);
return { bestMs, head: head.stdout.trim() };
