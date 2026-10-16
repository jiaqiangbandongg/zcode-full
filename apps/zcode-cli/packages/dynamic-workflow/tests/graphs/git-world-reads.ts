// git.* world reads feeding one ask: four source nodes, one sink. The point of this
// fixture next to grep-fanout is the OTHER container — and that the top-level log call in
// the middle stays chatter while the git container's log member is a site (the collision
// the registry keys around).
const changed = await git.changedFiles();
log(`changed: ${changed.length}`);
const commits = await git.log(5);
const status = await git.status();
const diff = await git.diff("HEAD");

const reviewer = agent("reviewer");
const summary = await reviewer.ask<string>(
  `Branch ${status.branch ?? "detached"} (clean=${status.clean}).\n` +
    `Changed: ${changed.join(", ")}\n` +
    `Recent: ${commits.map((c) => c.subject).join(" | ")}\n` +
    `Diff size: ${diff.length}`,
);
return summary;
