// Optional call on a maybe-undefined script-local function: when defined at
// runtime, helper's ask consumes the secret and its result flows onward.
const scout = agent("scout");
const secret = await scout.ask("find the secret");
const helper = async (s: string): Promise<string> => agent("h").ask(`handle ${s}`);
const f = secret.length > 3 ? helper : undefined;
const out = await f?.(secret);
return agent("act").ask(`out ${out}`);
