// An un-awaited ask in a loop on a FIXED actor. Nothing awaits inside the body, so the
// instances are issued back-to-back — but the actor's mailbox still serializes them,
// so the cue is a self-arrow (`fifo`, repeat=serial) rather than a stack.
const logger = agent("logger");
const topics = await files.glob("*.md");
for (const topic of topics) {
  logger.ask<string>(`note ${topic}`);
}
return topics;
