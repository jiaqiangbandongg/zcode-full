import { describe, expect, it } from "vitest";
import {
  GENERIC_SUBMIT_PROFILE,
  buildAskSpecs,
  collectSites,
  createWorkflowProgram,
  deriveActorSubmitProfiles,
  deriveActorSubmitProfilesFor,
  synthesizeAskSchemas,
  type ActorSubmitProfile,
  type AskSpec,
  type SiteGraph,
} from "../src/index.js";

// 每个 actor 站点的 submit profile（docs/execution-engine.md「Submit
// profiles」）：真实脚本 → 同一 Program 上的站点表 + schema 合成 + 站点图 → profile。

function profilesOf(script: string): {
  profiles: Map<string, ActorSubmitProfile>;
  schemas: Record<string, unknown>;
} {
  const workflow = createWorkflowProgram(script);
  const table = collectSites(workflow);
  const { diagnostics, schemas } = synthesizeAskSchemas(workflow, table);
  expect(diagnostics).toEqual([]);
  const askSpecs = buildAskSpecs(table, schemas);
  return { profiles: deriveActorSubmitProfilesFor(workflow, table, askSpecs), schemas };
}

describe("actor submit profiles — from real scripts", () => {
  it("a one-shot typed actor is mono with that ask's schema", () => {
    const { profiles, schemas } = profilesOf(
      [
        `interface Plan { done: boolean }`,
        `const a = agent("a");`,
        `const p = await a.ask<Plan>("plan");`,
        `return p;`,
      ].join("\n"),
    );
    expect(profiles.get("actor#1")).toEqual({ kind: "mono", schema: schemas["ask#1"] });
  });

  it("two typed asks with the same T stay mono; untyped asks in between do not matter", () => {
    const { profiles, schemas } = profilesOf(
      [
        `interface Plan { done: boolean }`,
        `const a = agent("a");`,
        `const p = await a.ask<Plan>("plan");`,
        `const t = await a.ask("say hi");`,
        `const q = await a.ask<Plan>("plan again " + t);`,
        `return [p, q];`,
      ].join("\n"),
    );
    expect(profiles.get("actor#1")).toEqual({ kind: "mono", schema: schemas["ask#1"] });
    // 同一 T 在两个站点各合成一次：引用不同、内容相同，按内容判等。
    expect(schemas["ask#1"]).not.toBe(schemas["ask#3"]);
    expect(schemas["ask#1"]).toEqual(schemas["ask#3"]);
  });

  it("two typed asks with different T make the actor generic", () => {
    const { profiles } = profilesOf(
      [
        `interface Plan { done: boolean }`,
        `interface Review { ok: boolean; notes: string }`,
        `const a = agent("a");`,
        `const p = await a.ask<Plan>("plan");`,
        `const r = await a.ask<Review>("review");`,
        `return [p, r];`,
      ].join("\n"),
    );
    expect(profiles.get("actor#1")).toEqual(GENERIC_SUBMIT_PROFILE);
  });

  it("an actor with only untyped asks is untyped (no submit_result)", () => {
    const { profiles } = profilesOf(
      [
        `const a = agent("a");`,
        `const x = await a.ask("plain");`,
        `const y = await a.ask<string>("still plain " + x);`,
        `return y;`,
      ].join("\n"),
    );
    expect(profiles.get("actor#1")).toEqual({ kind: "untyped" });
  });

  it("independent actors get independent profiles", () => {
    const { profiles, schemas } = profilesOf(
      [
        `interface Plan { done: boolean }`,
        `interface Review { ok: boolean }`,
        `const planner = agent("planner");`,
        `const judge = agent("judge", { system: "You judge." });`,
        `const talker = agent("talker");`,
        `const p = await planner.ask<Plan>("plan");`,
        `const r1 = await judge.ask<Review>("judge " + JSON.stringify(p));`,
        `const r2 = await judge.ask<Plan>("re-plan " + JSON.stringify(r1));`,
        `const t = await talker.ask("summarize " + JSON.stringify(r2));`,
        `return t;`,
      ].join("\n"),
    );
    expect(profiles.get("actor#1")).toEqual({ kind: "mono", schema: schemas["ask#1"] });
    expect(profiles.get("actor#2")).toEqual(GENERIC_SUBMIT_PROFILE);
    expect(profiles.get("actor#3")).toEqual({ kind: "untyped" });
    expect([...profiles.keys()].sort()).toEqual(["actor#1", "actor#2", "actor#3"]);
  });

  it("a fan-out lane family is one actor site and stays mono across iterations", () => {
    const { profiles, schemas } = profilesOf(
      [
        `interface Finding { file: string; ok: boolean }`,
        `const files = await world.files.glob("src/**/*.ts");`,
        `const results = await Promise.all(files.map((file) => agent("rev-" + file).ask<Finding>("review " + file)));`,
        `return results;`,
      ].join("\n"),
    );
    expect(profiles.get("actor#1")).toEqual({ kind: "mono", schema: schemas["ask#1"] });
  });

  it("a receiver that may be either of two actors contributes its schema to both", () => {
    const { profiles, schemas } = profilesOf(
      [
        `interface Plan { done: boolean }`,
        `const a = agent("a");`,
        `const b = agent("b");`,
        `const files = await world.files.glob("src/**/*.ts");`,
        `const who = files.length > 3 ? a : b;`,
        `const p = await who.ask<Plan>("plan");`,
        `return p;`,
      ].join("\n"),
    );
    expect(profiles.get("actor#1")).toEqual({ kind: "mono", schema: schemas["ask#1"] });
    expect(profiles.get("actor#2")).toEqual({ kind: "mono", schema: schemas["ask#1"] });
  });
});

describe("actor submit profiles — soundness on the pure projection", () => {
  const schemaA = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  const schemaB = { type: "object", properties: { b: { type: "number" } }, required: ["b"] };
  const graphWith = (nodes: SiteGraph["nodes"]): SiteGraph => ({
    actors: [
      { id: "actor#1", loc: { column: 1, line: 1 }, order: 0 },
      { id: "actor#2", loc: { column: 1, line: 2 }, order: 1 },
    ] as SiteGraph["actors"],
    edges: [],
    nodes,
  });
  const ask = (id: string, actors: string[] | undefined): SiteGraph["nodes"][number] =>
    ({
      id,
      kind: "ask",
      label: id,
      loc: { column: 1, line: 3 },
      order: 2,
      ...(actors === undefined ? {} : { actors }),
    }) as SiteGraph["nodes"][number];
  const specs = (entries: [string, AskSpec][]) => new Map<string, AskSpec>(entries);

  it("one unresolved ask makes every actor generic, even the ones with a clean picture", () => {
    const profiles = deriveActorSubmitProfiles(
      graphWith([ask("ask#1", ["actor#1"]), ask("ask#2", undefined)]),
      specs([
        ["ask#1", { typed: true, schema: schemaA }],
        ["ask#2", { typed: true, schema: schemaB }],
      ]),
    );
    expect(profiles.get("actor#1")).toEqual(GENERIC_SUBMIT_PROFILE);
    expect(profiles.get("actor#2")).toEqual(GENERIC_SUBMIT_PROFILE);
  });

  it("a missing ask spec is a wiring error and also falls back to generic for all", () => {
    const profiles = deriveActorSubmitProfiles(graphWith([ask("ask#1", ["actor#1"])]), specs([]));
    expect(profiles.get("actor#1")).toEqual(GENERIC_SUBMIT_PROFILE);
    expect(profiles.get("actor#2")).toEqual(GENERIC_SUBMIT_PROFILE);
  });

  it("schema equality is by canonical content, not by key order or identity", () => {
    const reordered = { required: ["a"], properties: { a: { type: "string" } }, type: "object" };
    const profiles = deriveActorSubmitProfiles(
      graphWith([ask("ask#1", ["actor#1"]), ask("ask#2", ["actor#1"])]),
      specs([
        ["ask#1", { typed: true, schema: schemaA }],
        ["ask#2", { typed: true, schema: reordered }],
      ]),
    );
    expect(profiles.get("actor#1")).toEqual({ kind: "mono", schema: schemaA });
    expect(profiles.get("actor#2")).toEqual({ kind: "untyped" });
  });

  it("an actor that no ask reaches is untyped", () => {
    const profiles = deriveActorSubmitProfiles(graphWith([]), specs([]));
    expect(profiles.get("actor#1")).toEqual({ kind: "untyped" });
    expect(profiles.get("actor#2")).toEqual({ kind: "untyped" });
  });
});
