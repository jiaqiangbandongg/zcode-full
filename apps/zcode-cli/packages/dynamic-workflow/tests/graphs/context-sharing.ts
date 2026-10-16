// The context relation. `shared` is one actor asked at two sites -> a context edge
// between those asks (exact: same singleton actor). Two independent actors asked
// separately share no actor -> no context edge between them. An actor passed into a
// helper that asks it relates via the summary's actor taint.
// The helper `interrogate` is declared first, so its ask is ask#1; the direct
// `shared` asks are ask#2/ask#3. Context edges: ask#1 -> ask#2, ask#1 -> ask#3, ask#2 -> ask#3.
function interrogate(who: Agent, topic: string): Node<string> {
  return who.ask<string>(`about ${topic}`);
}

const shared = agent("shared");
const first = await shared.ask<string>("one");
const second = await shared.ask<string>("two");

const loner = agent("loner");
const alone = await loner.ask<string>("solo");

const soloTwo = await agent("ephemeral").ask<string>("throwaway");

const viaHelper = await interrogate(shared, "delegated");
return `${first} ${second} ${alone} ${soloTwo} ${viaHelper}`;
