// channel / future lower to host passthroughs (docs/dynamic-workflow/authoring.md, "Streams"):
// `channel<T>(name)` -> `__host.channel(name)` with the type argument dropped, `future(body)` ->
// `__host.future(body)`. Neither has a site id; `.send` / `.close` / `for await` are ordinary
// member calls on the cell's object and survive untouched.
interface Fact {
  claim: string;
}
const facts = channel<Fact>("facts");
const anonymous = channel<string>();
phase("gather");
const research = future(async () => {
  try {
    const found = await agent("researcher").ask<Fact[]>("find facts");
    for (const fact of found) facts.send(fact);
  } finally {
    facts.close();
  }
});
phase("verify");
const verify = future(async () => {
  const verdicts: string[] = [];
  for await (const fact of facts) {
    verdicts.push(await agent(`verifier-${fact.claim}`).ask(`verify ${fact.claim}`));
  }
  anonymous.close();
  return verdicts;
});
await research;
return verify;
