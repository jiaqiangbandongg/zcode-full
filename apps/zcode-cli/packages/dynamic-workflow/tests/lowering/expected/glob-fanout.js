const paths = await __host.worldRead("world-read#1", "glob", ["src/**/*.ts"]);
const verdicts = await Promise.all(paths.map((p) => __host.ask("ask#1", __host.createActor("actor#1", "reviewer"), `Security-review ${p}`)));
return verdicts.filter((v) => !v.approved).map((v) => v.reason);
