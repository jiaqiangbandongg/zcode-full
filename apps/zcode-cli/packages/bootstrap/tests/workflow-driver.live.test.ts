/**
 * Live 层集成测试（phase 1.5 步骤 7，**默认不跑**）：真实 driver + 真实 AgentRuntime + 真实 model adapter。
 * 用 `describe.skipIf` 按环境变量 `ZCODE_WORKFLOW_LIVE_TEST` 门控——缺省整块跳过，`pnpm test` 保持确定性。
 *
 * 如何运行：
 *   ZCODE_WORKFLOW_LIVE_TEST=1 pnpm --filter @zcode/bootstrap exec vitest run tests/workflow-driver.live.test.ts
 * 凭据与模型直接取自本机 v2 配置（~/.zcode/v2/config.json + setting.json）里活跃的 provider——见
 * resolveV2ModelConfig。无需额外 env（可选 ZCODE_WORKFLOW_LIVE_MODEL 覆盖模型 id）。若本机无 v2
 * 配置或活跃 provider 无内联 apiKey，则整块跳过。
 *
 * 覆盖真模型才能验证的东西（phase 1 用 fake driver 无法证）：真实 submit 的 schema 一致性、
 * repair 在预算 3 内的修复效力、nudge 行为、以及 resume over a live-model journal with zero dispatches。
 * 第二个 describe 块把覆盖面扩到工作流形态：顺序流水线、并行 fan-out+join、数据依赖分支、
 * 同 actor 上下文延续、反馈驱动循环、world-read 喂 ask。
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestAgentRuntime } from "./helpers/test-agent-runtime.js";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { parseModelRef, type RuntimeModelConfig } from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";
import { InMemoryJournalStore, inputHash } from "@zcode/dynamic-workflow";
import { createModelAdapter } from "../src/index.js";
import { workflowActorToolPolicy } from "../src/app/workflow-actor-tools.js";
import { fakeFileSystemPort, runDriverScript, type PlannedResponse } from "./workflow-driver.helpers.js";
import type { ActorRuntimeFactory } from "../src/app/workflow-driver.js";

/**
 * 直接读取本机 v2 配置（~/.zcode/v2/config.json + setting.json）解析出活跃 provider 的凭据与模型，
 * 构造 RuntimeModelConfig 注入 createModelAdapter —— 镜像生产里桌面经协议下发 bootstrapModelConfig
 * 的做法。CLI 的 createConfig 只读已废弃的 v1 ~/.zcode/cli/config.json，不认 v2 provider map（v2 的
 * 原生解析在桌面 @zcode/services，按协议边界不被 CLI 依赖），所以这里让 live 测试自解析 v2 并注入
 * modelConfig，而不是依赖那条会落到 v1 空配置的 fallback。测试专用，只读不写，绝不落盘或打印密钥。
 * 可用 ZCODE_WORKFLOW_LIVE_MODEL 覆盖模型 id。
 */
interface ResolvedLiveModel {
  modelConfig: RuntimeModelConfig;
  modelRef: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveV2ModelConfig(): ResolvedLiveModel | undefined {
  const configPath = join(homedir(), ".zcode", "v2", "config.json");
  if (!existsSync(configPath)) return undefined;
  let providers: Record<string, any>;
  try {
    providers = JSON.parse(readFileSync(configPath, "utf8")).provider ?? {};
  } catch {
    return undefined;
  }
  const providerId = pickActiveProviderId(providers);
  if (providerId === undefined) return undefined;
  const p = providers[providerId];
  const apiKey: string | undefined = p?.options?.apiKey;
  if (!apiKey) return undefined; // 无内联 key（如 oauth-only family）：跳过，本 live 测试只覆盖 apiKey provider。
  const modelId: string | undefined = process.env.ZCODE_WORKFLOW_LIVE_MODEL ?? Object.keys(p.models ?? {})[0];
  if (!modelId) return undefined;
  return {
    modelConfig: { main: { kind: p.kind, provider: providerId, model: modelId, apiKey, baseURL: p?.options?.baseURL } },
    modelRef: `${providerId}/${modelId}`,
  };
}

/** 活跃 provider：优先 setting.json 的 family 选择，否则取 enabled 且带 apiKey 的第一个。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickActiveProviderId(providers: Record<string, any>): string | undefined {
  const settingPath = join(homedir(), ".zcode", "v2", "setting.json");
  if (existsSync(settingPath)) {
    try {
      const s = JSON.parse(readFileSync(settingPath, "utf8"));
      const key: unknown = s.modelProviderFamilySelectedKeys?.[s.providerFamilyDomain];
      // key 形如 "preset:builtin:bigmodel" / "coding-plan:builtin:zai-coding-plan"：取首个冒号后的 provider id。
      if (typeof key === "string") {
        const id = key.slice(key.indexOf(":") + 1);
        if (providers[id]?.options?.apiKey) return id;
      }
    } catch {
      /* 落到下面的 enabled+key 兜底 */
    }
  }
  for (const [id, p] of Object.entries(providers)) {
    if (p?.enabled !== false && typeof p?.options?.apiKey === "string" && p.options.apiKey.length > 0) return id;
  }
  return undefined;
}

const RESOLVED = process.env.ZCODE_WORKFLOW_LIVE_TEST ? resolveV2ModelConfig() : undefined;
const LIVE = Boolean(RESOLVED);

/**
 * ZCODE_WORKFLOW_LIVE_TRANSCRIPT=<path>：把每次模型请求/应答以 JSONL 追加到该文件，供人工/agent
 * 复核真实会话是否合理（schema 尾注、submit 载荷、feedback 线程化、同 actor 上下文延续）。
 * 请求体不含凭据（key 在 adapter 闭包里）；仅调试用，缺省关闭、零开销。
 */
function withTranscript<T>(adapter: T): T {
  const path = process.env.ZCODE_WORKFLOW_LIVE_TRANSCRIPT;
  if (!path) return adapter;
  let seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = adapter as any;
  const write = (entry: Record<string, unknown>) =>
    appendFileSync(path, `${JSON.stringify({ seq: ++seq, at: new Date().toISOString(), ...entry })}\n`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slim = (req: any) => ({
    model: req?.model,
    toolNames: req?.tools?.map((t: { name: string }) => t.name),
    toolChoice: req?.toolChoice,
    messages: req?.messages,
  });
  const wrapped = Object.create(base);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapped.generateText = async (req: any) => {
    const res = await base.generateText(req);
    write({
      kind: "generateText",
      request: slim(req),
      response: { finishReason: res?.finishReason, text: res?.text, toolCalls: res?.toolCalls, usage: res?.usage },
    });
    return res;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapped.streamText = (req: any) => {
    const inner = base.streamText(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const events: any[] = [];
    async function* logged() {
      try {
        for await (const e of inner) {
          events.push(e);
          yield e;
        }
      } finally {
        write({ kind: "streamText", request: slim(req), events });
      }
    }
    return logged();
  };
  return wrapped as T;
}

/** 真实 model adapter 支撑的 runtime 工厂（每 actor 一个持久 child runtime）；注入 v2 modelConfig。 */
function liveRuntimeFactory(resolved: ResolvedLiveModel): ActorRuntimeFactory {
  const modelAdapter = withTranscript(
    createModelAdapter({
      env: process.env,
      appVersion: "wf-live-test",
      modelConfig: resolved.modelConfig,
    }),
  );
  const modelRef = parseModelRef(resolved.modelRef);
  const fileSystemPort = fakeFileSystemPort({});
  return ({ sessionId, persona, submitPort }) =>
    createTestAgentRuntime(
      sessionId,
      {
        systemPrompt: persona.system ?? "You are a workflow actor. Follow the instructions precisely.",
        mode: "yolo",
        taskType: "workflow_child",
        subagents: { enabled: false },
        modelRef,
        // actor 的工具面：全集减去会悬挂/越权的交互工具。
        ...workflowActorToolPolicy(),
      },
      {
        eventStore: createInMemorySessionEventStore(),
        modelAdapter,
        workflowSubmitPort: submitPort,
        fileSystemPort,
      },
    );
}

const noScripts: Record<string, PlannedResponse[]> = {};

describe.skipIf(!LIVE)("workflow driver — LIVE (env-gated)", () => {
  it(
    "a real model submits a schema-conforming result and the run completes",
    async () => {
      const script = [
        "interface Summary { title: string; bullet_points: string[]; }",
        'const worker = agent("worker", "You summarize short texts into a title and bullet points.");',
        'const s = await worker.ask<Summary>("Summarize: The cat sat on the mat, then chased a mouse.");',
        "return s;",
      ].join("\n");

      const { settlement, journal } = await runDriverScript(script, {
        actorScripts: noScripts,
        runtimeFactory: liveRuntimeFactory(RESOLVED!),
        timeoutMs: 120_000,
      });

      expect(settlement.status).toBe("completed");
      const node = journal.getNode("run", "ask#1", 1);
      expect(node?.status).toBe("completed");
      const result = node?.result as { title?: unknown; bullet_points?: unknown } | undefined;
      expect(typeof result?.title).toBe("string");
      expect(Array.isArray(result?.bullet_points)).toBe(true);
    },
    130_000,
  );

  it(
    "resumes over a live-model journal with zero dispatches",
    async () => {
      const script = [
        "interface Answer { value: number; }",
        'const a = await agent("mathy", "You do arithmetic.").ask<Answer>("What is 21 + 21? Return the number.");',
        "return a;",
      ].join("\n");

      const journal = new InMemoryJournalStore();
      const first = await runDriverScript(script, {
        journal,
        actorScripts: noScripts,
        runtimeFactory: liveRuntimeFactory(RESOLVED!),
        timeoutMs: 120_000,
      });
      expect(first.settlement.status).toBe("completed");

      // Resume：复用 journal，工厂设为「被调用即抛错」以硬断言零派发。
      let dispatched = false;
      const throwingFactory: ActorRuntimeFactory = (input) => {
        dispatched = true;
        return liveRuntimeFactory(RESOLVED!)(input);
      };
      const resumed = await runDriverScript(script, {
        journal,
        actorScripts: noScripts,
        runtimeFactory: throwingFactory,
        timeoutMs: 30_000,
      });
      expect(resumed.settlement).toEqual(first.settlement);
      expect(dispatched).toBe(false);
    },
    140_000,
  );
});

/**
 * 模式覆盖（live）：真实模型跑「工作流形态」而非单点 ask——顺序流水线、并行 fan-out+join、
 * 数据依赖分支、同 actor 多 ask 的上下文延续、反馈驱动的循环、world-read 喂给真实 ask。
 * 断言优先押引擎性质（journal 结构、actorSeq、分支唯一性、结果自洽），少押模型答案；
 * 需要押模型时只押小学算术、明显情感这类几乎不会错的行为。
 */
describe.skipIf(!LIVE)("workflow driver — LIVE workflow patterns (env-gated)", () => {
  it(
    "seq: threads one ask's typed output into the next actor's prompt",
    async () => {
      const script = [
        "interface Extracted { numbers: number[]; }",
        "interface Parity { even: boolean; }",
        'const extractor = agent("extractor", "You extract integers from text.");',
        'const e = await extractor.ask<Extracted>("Extract all the integers: there are 3 cats, 5 dogs and 14 birds.");',
        "const sum = e.numbers.reduce((a, b) => a + b, 0);",
        'const checker = agent("checker", { system: "You answer arithmetic questions." });',
        "const p = await checker.ask<Parity>(`Is the number ${sum} even?`);",
        "return { sum, even: p.even };",
      ].join("\n");

      const { settlement, journal } = await runDriverScript(script, {
        actorScripts: noScripts,
        runtimeFactory: liveRuntimeFactory(RESOLVED!),
        timeoutMs: 150_000,
      });

      expect(settlement.status).toBe("completed");
      if (settlement.status !== "completed") return;

      // 自洽：sum 由 ask#1 的 journal 产物重算，parity 是它的确定函数。
      const extracted = journal.getNode("run", "ask#1", 1)?.result as { numbers: number[] };
      expect(Array.isArray(extracted.numbers)).toBe(true);
      const sum = extracted.numbers.reduce((a, b) => a + b, 0);
      const artifact = settlement.artifact as { sum: number; even: boolean };
      expect(artifact.sum).toBe(sum);
      expect(artifact.even).toBe(sum % 2 === 0);
      // 线程化证明：ask#2 的 inputHash 等于「嵌入了 ask#1 产物」的 prompt 的哈希。
      expect(journal.getNode("run", "ask#2", 1)?.inputHash).toBe(inputHash(`Is the number ${sum} even?`));
    },
    170_000,
  );

  it(
    "parallel: fans out over Promise.all onto fresh actors, then reduces via an aggregator ask",
    async () => {
      const script = [
        "interface Value { value: number; }",
        "interface Total { total: number; }",
        'const problems = ["2 + 3", "10 + 4", "7 + 6"];',
        "const values = await Promise.all(",
        '  problems.map((p) => agent("solver").ask<Value>(`Compute ${p} and return the value.`)),',
        ");",
        "const nums = values.map((v) => v.value);",
        'const agg = await agent("aggregator", { system: "You add numbers." })',
        "  .ask<Total>(`Add these numbers: ${nums.join(\", \")}. Return the total.`);",
        "return { nums, total: agg.total };",
      ].join("\n");

      const { settlement, journal, events } = await runDriverScript(script, {
        actorScripts: noScripts,
        runtimeFactory: liveRuntimeFactory(RESOLVED!),
        timeoutMs: 180_000,
      });

      expect(settlement.status).toBe("completed");
      if (settlement.status !== "completed") return;

    // fan-out：ask#1 三个实例（各自新 actor）+ aggregator，共 4 个 ask 节点、4 个 actor。
    const askNodes = journal
      .listNodes("run", { kinds: "all", withResult: true })
      .filter((n) => n.kind === "ask");
    expect(askNodes).toHaveLength(4);
    expect(askNodes.every((n) => n.status === "completed")).toBe(true);
    expect(events.filter((e) => e.type === "actor-created")).toHaveLength(4);

      const artifact = settlement.artifact as { nums: number[]; total: number };
      expect(artifact.nums).toEqual([5, 14, 13]);
      expect(artifact.total).toBe(32);
      // 自洽（与绝对值互为冗余）：total 等于三个 fan-out journal 产物之和。
      const fanned = askNodes
        .filter((n) => n.siteId === "ask#1")
        .map((n) => (n.result as { value: number }).value);
      expect(fanned).toHaveLength(3);
      expect(fanned.reduce((a, b) => a + b, 0)).toBe(artifact.total);
    },
    200_000,
  );

  it(
    "control: branches on a typed enum verdict; only the taken branch's ask is journaled",
    async () => {
      const script = [
        'interface Verdict { sentiment: "positive" | "negative"; }',
        'const judge = agent("judge", { system: "You classify sentiment." });',
        'const v = await judge.ask<Verdict>("Classify the sentiment: I absolutely love this product, it works perfectly.");',
        'if (v.sentiment === "positive") {',
        '  const cheer = await agent("fan").ask("Reply with one short cheerful sentence.");',
        "  return { sentiment: v.sentiment, reply: cheer };",
        "}",
        'const sigh = await agent("consoler").ask("Reply with one short consoling sentence.");',
        "return { sentiment: v.sentiment, reply: sigh };",
      ].join("\n");

      const { settlement, journal } = await runDriverScript(script, {
        actorScripts: noScripts,
        runtimeFactory: liveRuntimeFactory(RESOLVED!),
        timeoutMs: 150_000,
      });

      expect(settlement.status).toBe("completed");
      if (settlement.status !== "completed") return;

      // enum schema 一致性：真实提交落在字面量并集内。
      const verdictNode = journal.getNode("run", "ask#1", 1);
      const verdict = (verdictNode?.result as { sentiment: string } | undefined)?.sentiment;
      expect(["positive", "negative"]).toContain(verdict);
      // 分支唯一性：恰好执行了 verdict 对应的那一支（不押 verdict 本身）。
      expect(journal.getNode("run", "ask#2", 1) !== undefined).toBe(verdict === "positive");
      expect(journal.getNode("run", "ask#3", 1) !== undefined).toBe(verdict === "negative");
      // 分支 ask 是 untyped：从真实 turn 的 final text 结算出非空字符串。
      const artifact = settlement.artifact as { sentiment: string; reply: string };
      expect(artifact.sentiment).toBe(verdict);
      expect(typeof artifact.reply).toBe("string");
      expect(artifact.reply.length).toBeGreaterThan(0);
    },
    170_000,
  );

  it(
    "actor context: a second ask on the same actor recalls facts from the first (FIFO, one runtime)",
    async () => {
      // 码字只出现在 ask#1 的 prompt；ask#2 能答出它的唯一途径是持久 child runtime 的会话历史。
      const script = [
        "interface Ack { ok: boolean; }",
        "interface Recall { codeword: string; }",
        'const keeper = agent("keeper", "You remember facts from this conversation and answer recall questions.");',
        'await keeper.ask<Ack>("Remember the codeword PLUM-42. Reply with ok=true.");',
        'const r = await keeper.ask<Recall>("What codeword were you asked to remember earlier in this conversation? Return exactly that codeword.");',
        "return r;",
      ].join("\n");

      const { settlement, journal, events } = await runDriverScript(script, {
        actorScripts: noScripts,
        runtimeFactory: liveRuntimeFactory(RESOLVED!),
        timeoutMs: 150_000,
      });

      expect(settlement.status).toBe("completed");
      if (settlement.status !== "completed") return;

      expect((settlement.artifact as { codeword: string }).codeword).toContain("PLUM-42");
      // 同一 actor 站点上的串行两问：单 actor、actorSeq 0 → 1。
      expect(events.filter((e) => e.type === "actor-created")).toHaveLength(1);
      const first = journal.getNode("run", "ask#1", 1);
      const second = journal.getNode("run", "ask#2", 1);
      expect(first?.actorSiteId).toBe("actor#1");
      expect(second?.actorSiteId).toBe("actor#1");
      expect(first?.actorSeq).toBe(0);
      expect(second?.actorSeq).toBe(1);
    },
    170_000,
  );

  it(
    "loop: a feedback-driven loop converges — each round threads script feedback into the next ask",
    async () => {
      // 秘密数写死在脚本里（7）；反馈（too low/too high）由脚本代码生成并嵌入下一轮 prompt。
      // 有反馈的猜数对任何可用模型 ≤6 轮必收敛（二分 4 轮），收敛性可押。
      const script = [
        "interface Guess { value: number; }",
        'const guesser = agent("guesser", { system: "You guess integers, using the feedback on your earlier guesses." });',
        'let feedback = "none yet";',
        "let found = -1;",
        "let rounds = 0;",
        "for (let i = 0; i < 6 && found === -1; i++) {",
        "  rounds = i + 1;",
        "  const g = await guesser.ask<Guess>(`Guess the secret integer between 1 and 10. Feedback on your previous guess: ${feedback}.`);",
        "  if (g.value === 7) { found = g.value; }",
        "  else { feedback = g.value < 7 ? `${g.value} is too low` : `${g.value} is too high`; }",
        "}",
        "return { found, rounds };",
      ].join("\n");

      const { settlement, journal, events } = await runDriverScript(script, {
        actorScripts: noScripts,
        runtimeFactory: liveRuntimeFactory(RESOLVED!),
        timeoutMs: 300_000,
      });

      expect(settlement.status).toBe("completed");
      if (settlement.status !== "completed") return;

    const artifact = settlement.artifact as { found: number; rounds: number };
    expect(artifact.found).toBe(7);
    expect(artifact.rounds).toBeGreaterThanOrEqual(1);
    expect(artifact.rounds).toBeLessThanOrEqual(6);
    // 同一 ask 站点的第 N 轮 = 实例 N，全部 completed，串行落在同一 actor 上（actorSeq 递增）。
    const askNodes = journal
      .listNodes("run", { kinds: "all", withResult: true })
      .filter((n) => n.kind === "ask");
    expect(askNodes).toHaveLength(artifact.rounds);
    expect(askNodes.every((n) => n.status === "completed" && n.actorSiteId === "actor#1")).toBe(
      true,
    );
    expect(events.filter((e) => e.type === "actor-created")).toHaveLength(1);
    expect(journal.getNode("run", "ask#1", artifact.rounds)?.actorSeq).toBe(artifact.rounds - 1);
  }, 320_000);

  it(
    "world reads: file content read by the harness is consumed by a live typed ask",
    async () => {
      const script = [
        "interface Config { port: number; }",
        'const text = await files.read("config/server.txt");',
        'const parser = agent("parser", { system: "You extract fields from configuration text." });',
        "const c = await parser.ask<Config>(`In the following config, what is the port?\\n${text}`);",
        "return c;",
      ].join("\n");

      const content = "host = example.com\nport = 4823\ntimeout = 30\n";
      const { settlement, journal } = await runDriverScript(script, {
        actorScripts: noScripts,
        runtimeFactory: liveRuntimeFactory(RESOLVED!),
        files: { read: content },
        timeoutMs: 130_000,
      });

      expect(settlement.status).toBe("completed");
      if (settlement.status !== "completed") return;

      // world-read 照常落 journal；真实模型从被嵌入 prompt 的文件内容里抽出字段。
      expect(journal.getNode("run", "world-read#1", 1)?.result).toBe(content);
      expect((settlement.artifact as { port: number }).port).toBe(4823);
    },
    150_000,
  );
});
