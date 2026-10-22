__host.log("starting");
const worker = __host.createActor("actor#1", "worker");
const s = await __host.ask("ask#1", worker, "Summarize the repo");
__host.log(`summary: ${s.text}`);
return s.text;
