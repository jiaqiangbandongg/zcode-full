const scout = __host.createActor("actor#1", "scout");
__host.log("scanning");
const paths = await __host.worldRead("world-read#1", "glob", ["src/**/*.ts"]);
__host.report("report#1", { phase: "scanned", total: paths.length });
const findings = [];
for (const path of paths) {
    const note = await __host.ask("ask#1", scout, `review ${path}`);
    __host.report("report#2", { path, note });
    findings.push({ path, note });
}
__host.log("done");
__host.report("report#3", { phase: "done", total: findings.length });
return findings;
