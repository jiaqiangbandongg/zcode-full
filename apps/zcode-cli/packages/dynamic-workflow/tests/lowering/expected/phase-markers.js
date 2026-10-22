// Phase markers erase: the sandbox has no `phase` binding to call, so every marker must
// lower to `void 0` — a leftover free identifier is a run-time ReferenceError. The markers
// here stand in every position that survives to the sandbox: script top, inside a block,
// and right before the return. Comments survive lowering, so this one deliberately avoids
// spelling the marker as a call: the suite greps the lowered text for one.
__host.enterPhase("preflight");
const paths = await __host.worldRead("world-read#1", "glob", ["src/**/*.ts"]);
const reviewer = __host.createActor("actor#1", "reviewer");
if (paths.length > 0) {
    __host.enterPhase("review");
    const first = paths[0] ?? "src/index.ts";
    const verdict = await __host.ask("ask#1", reviewer, `Review ${first}`);
    __host.report("report#1", { first, verdict });
    __host.log("reviewed");
}
__host.enterPhase("wrap-up");
return paths.length;
