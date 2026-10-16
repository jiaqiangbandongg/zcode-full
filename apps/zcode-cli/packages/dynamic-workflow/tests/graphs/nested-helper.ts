// Asks live inside a script-local helper function: they must still be collected,
// and the helper's own `return` must NOT count as a top-level (sink) return.
async function investigate(topic: string): Promise<string> {
  const worker = agent("worker");
  const result = await worker.ask<string>(`Investigate ${topic}`);
  return result;
}

const alpha = await investigate("alpha");
const beta = await investigate("beta");
return `${alpha} ${beta}`;
