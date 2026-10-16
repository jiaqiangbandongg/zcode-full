// Callback invocation family: a `new Promise(executor)` whose executor issues an ask. The
// registry says a Promise executor runs once, synchronously and certainly, so the body
// inlines as an entered `call` labelled "Promise" and the ask keeps `always` certainty.
phase("gate");
const gate = await new Promise<string>((resolve) => {
  agent("gatekeeper").ask<string>("may we proceed?").then(resolve);
});
phase("act");
const done = await agent("actor").ask<string>(`proceed: ${gate}`);
return done;
