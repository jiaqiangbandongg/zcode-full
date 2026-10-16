// git.log vs the top-level log(): the collision the world-read registry exists for.
// Both spellings appear here, both are legal, and they must resolve to different things —
// `git.log(5)` is a world-read site, `log("...")` is progress chatter with no site.
const commits = await git.log(5);
log(`scanning ${commits.length} commits`);

const changed = await git.changedFiles();
const status = await git.status();
log(`branch ${status.branch ?? "(detached)"}, clean=${status.clean}`);

const diff = await git.diff("HEAD", changed[0] ?? "package.json");
const hits = await files.grep("TODO", "*.ts");

const reviewer = agent("reviewer");
const verdict = await reviewer.ask<string>(
  `Commits: ${commits.map((c) => c.subject).join("; ")}\n` +
    `Untracked: ${status.untracked.length}\n` +
    `Diff bytes: ${diff.length}\n` +
    `First TODO: ${hits[0]?.path ?? "none"}:${hits[0]?.line ?? 0}`,
);
return verdict;
