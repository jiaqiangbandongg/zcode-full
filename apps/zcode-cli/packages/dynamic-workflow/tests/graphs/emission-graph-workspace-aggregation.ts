// Two distinct world-read sites feeding one ask: the actor projection must aggregate
// both into ONE workspace node with a single workspace -> dev edge of count 2 (exact),
// and the site graph keeps world#1 / world#2 apart with source completion on each.
const spec = await files.read("SPEC.md");
const conf = await files.read("conf.json");
const plan = await agent("dev").ask<string>(`implement ${spec} using ${conf}`);
return plan;
