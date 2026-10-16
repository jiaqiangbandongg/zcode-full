// Multi-argument and optional-argument world reads. What this pins in the lowered output:
// arguments are packed positionally, and an absent trailing optional yields a SHORTER
// array — not a `undefined` hole — because `inputHash({op, args})` is the journal key and
// `["TODO"]` must not hash the same as `["TODO", undefined]`.
const hits = await files.grep("TODO");
const narrowed = await files.grep("TODO", "*.ts");
const changed = await git.changedFiles();
const againstMain = await git.changedFiles("main");
const wholeDiff = await git.diff();
const onePath = await git.diff("main", "src/a.ts");
const state = await git.status();
const recent = await git.log();
const fiveCommits = await git.log(5);
// The collision case, in lowered form: a top-level log call becomes __host.log, while the
// git container's log member becomes __host.worldRead with the "git-log" op.
log(`${hits.length} / ${narrowed.length}`);
return {
  changed: changed.length + againstMain.length,
  commits: recent.length + fiveCommits.length,
  diffBytes: wholeDiff.length + onePath.length,
  branch: state.branch ?? "detached",
};
