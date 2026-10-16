// Callback invocation family: a `.then` continuation registered inside a phase. Once-deferred
// per the registry: the body inlines at the call as a skippable `choice > branch > call`
// (it runs iff the receiver fulfils), opened by a LOCAL may-settle of the receiver's step, so
// writer precedes editor; phase membership is phase#2, where the continuation is registered.
phase("draft");
const draft = agent("writer").ask<string>("draft");
phase("edit");
const edited = await draft.then((t) => agent("editor").ask<string>(`edit ${t}`));
return edited;
