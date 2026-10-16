interface Summary {
  text: string;
}

log("starting");
const worker = agent("worker");
const s = await worker.ask<Summary>("Summarize the repo");
log(`summary: ${s.text}`);
return s.text;
