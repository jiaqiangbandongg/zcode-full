// A helper containing an ask, called from two sites. Phase 1 ships ONE step per site,
// so both calls collapse onto `ask#1`: the walk records two issue events for it, and
// no repetition cue appears (two call sites are not a region). Phase 3's site
// specialization splits it into `ask#1/1` and `ask#1/2`, at which point the two
// `await`s show as an ordered pair — an intended snapshot change.
const worker = agent("worker");
async function run(topic: string): Promise<string> {
  return await worker.ask<string>(`work on ${topic}`);
}
const first = await run("alpha");
const second = await run("beta");
return `${first} ${second}`;
