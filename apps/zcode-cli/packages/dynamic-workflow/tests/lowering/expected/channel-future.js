const facts = __host.channel("facts");
const anonymous = __host.channel();
__host.enterPhase("gather");
const research = __host.future(async () => {
    try {
        const found = await __host.ask("ask#1", __host.createActor("actor#1", "researcher"), "find facts");
        for (const fact of found)
            facts.send(fact);
    }
    finally {
        facts.close();
    }
});
__host.enterPhase("verify");
const verify = __host.future(async () => {
    const verdicts = [];
    for await (const fact of facts) {
        verdicts.push(await __host.ask("ask#2", __host.createActor("actor#2", `verifier-${fact.claim}`), `verify ${fact.claim}`));
    }
    anonymous.close();
    return verdicts;
});
await research;
return verify;
