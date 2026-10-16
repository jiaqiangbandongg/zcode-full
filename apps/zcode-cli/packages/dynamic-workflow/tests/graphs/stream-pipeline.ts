// Streams (docs/dynamic-workflow/authoring.md, "Streams"): two stages written as futures, each
// opening with its own phase marker, joined by a channel. The channel is a container the taint
// analysis sees through: `facts.send(r)` writes the researcher's result into the channel's place
// and `for await (const fact of facts)` reads it back, so every producer draws a data edge to
// every consumer. The `future` bodies inline at the call as entered strands.
interface Fact {
  id: string;
  claim: string;
}
interface Verdict {
  holds: boolean;
}
const facts = channel<Fact>("facts");
const verified: Fact[] = [];

const research = future(async () => {
  phase("Gather facts from three angles");
  try {
    await Promise.all(
      ["a", "b", "c"].map(async (angle) => {
        const found = await agent(`researcher-${angle}`).ask<Fact[]>(`Find facts about ${angle}`);
        for (const fact of found) facts.send(fact);
      }),
    );
  } finally {
    facts.close();
  }
});

const verify = future(async () => {
  phase("Verify each fact as it arrives");
  await Promise.all(
    [1, 2].map(async () => {
      for await (const fact of facts) {
        const v = await agent(`verifier-${fact.id}`).ask<Verdict>(`Verify ${fact.claim}`);
        if (v.holds) verified.push(fact);
      }
    }),
  );
});

await Promise.all([research, verify]);
phase("Write the report");
return agent("writer").ask<string>(`Write up ${JSON.stringify(verified)}`);
