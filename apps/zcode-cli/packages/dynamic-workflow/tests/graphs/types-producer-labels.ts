// Producer-side artifact types on data edges (docs/analysis.md, "Edge
// attributes"). A named-interface ask prints as its name; a type-argument-less ask
// defaults to `string`; files.glob yields `string[]` and files.read yields `string`.
// Each producer flows into a single consumer ask (and on to the sink), so every data
// edge carries its producer's artifact type as a provenance label.
// Expected producer types:
//   ask#1 (scanner)  -> Flaky      (named interface)
//   ask#2 (planner)  -> string     (default T = string, no type argument)
//   world-read#1     -> string[]   (glob)
//   world-read#2     -> string     (read)
//   ask#3 (consumer) -> string
interface Flaky {
  findings: string[];
}

const flaky = await agent("scanner").ask<Flaky>("Find flaky tests");
const summary = await agent("planner").ask("Summarize the plan");
const paths = await files.glob("src/**/*.ts");
const one = await files.read("config.json");
const out = await agent("consumer").ask<string>(
  `flaky ${flaky.findings.join(",")} summary ${summary} paths ${paths.join(",")} one ${one}`,
);
return out;
