import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowScript,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  FACADE_DTS,
  lowerWorkflow,
  SNIPPET_FACADE_DTS,
  WORLD_RUN_LITERAL_CODE,
} from "../src/index.js";

// 段拆分（docs/dynamic-workflow/authoring.md「The facade」）承诺：FACADE_DTS 由段
// 拼接后逐字节确定。哈希在每次**有意的** facade 文本变更时更新（更新历史即 facade 的
// 变更账本），任何段级编辑都会撞上这条——那是有意的：改 facade 文本必须是一次显式决定，
// 而不是重排段落时的静默漂移。
//   - dfd383f3…（2026-08-26）：段拆分落地，对拆分前逐字节不变。
//   - fb2d9943…（2026-08-26）：world.run 段加入（docs/dynamic-workflow/authoring.md）。
//   - 7f7d36ee…（2026-08-27）：phase 段加入（docs/dynamic-workflow/presentation.md）。
//   - 198475cc…（2026-08-28）：args 段加入（docs/dynamic-workflow/launch.md）。
//   - 807e4b79…（2026-08-29）：merge 重算——feat/dynamic-workflow 的 phase 段与
//     dwf-reusable 的 args 段会师后的组合哈希（两侧各自的哈希均已不再是当前文本）。
//   - e7da7b7b…（2026-08-29）：phase 段 JSDoc 重写——提示层强制（必填 + 阶段名人类
//     可读、跟随会话语言），见 docs/dynamic-workflow/authoring.md「Phases」与
//     docs/dynamic-workflow/authoring.md「The skill」；声明集（declare 行）不变。
//   - 877a78c3…（2026-08-31）：actor 段 `agent()` JSDoc 重写——「name 是展示标签」改成
//     「非空名必须 run 内唯一，且是修订续跑（resume_from）缓存匹配的身份键」，含 fan-out
//     里静态名的教改写；phase 段那句「不像 actor 名，那只是展示标签」同批改口径。见
//     docs/execution-engine.md「Amend-resume」。声明集（declare 行）不变。
//   - 05c3401c…（2026-09-04）：artifact 段加入 + report 签名加第二实参
//     （docs/dynamic-workflow/authoring.md）。这一条**动了声明集**：新增 `declare const artifact`
//     与七个 spec 接口，`report` 变为 `(item: unknown, artifactId?: string)`。
//   - 499c4179…（2026-09-04）：`BoardSpec.title` 改名 `cardTitle`。原名与继承自
//     `ArtifactOptions` 的 `title`（看板自己的卡片标题）撞在同一个键上，两者都是 string 所以
//     TS 收下了它——代价是一个看板永远说不出「这块板叫内存回归，每张卡拿 name 字段当标题」。
//     spec 同日改名（docs/dynamic-workflow/authoring.md「The facade」）。
//   - 540a2054…（2026-09-04）：**纯散文**——actor 段的 artifact → result／output value，
//     把这个词让给 artifact.*。旧措辞（`Node<T>` 的「producing a typed artifact」、
//     `Agent.ask` 的「T is the task's output artifact」）说的是引擎内部那一义，而产物段
//     就在同一份 .d.ts 里用同一个词说用户面产物——模型一次看到两义。同批改的还有
//     CreateWorkflow 的 RULES 与 dynamic-workflows 技能正文，见
//     docs/dynamic-workflow/authoring.md「The guidance」 与 docs/dynamic-workflow/authoring.md「Artifacts: what the user keeps」 的
//     「术语」表。声明集（declare 行）不变。
//   - 0dd165d5…（2026-09-05）：**纯散文**——phase 段加「每个阶段至少含一次 ask 或一次
//     world.run」的规则与改写后的 Idiom 句（docs/dynamic-workflow/presentation.md 同日追记：
//     空阶段一闪而过、看不到进度，模型被教导不要写它）。声明集（declare 行）不变。
//   - 99abaa45…（2026-09-05）：**纯散文**——`ToolProfile` 与 `AgentPersona.tools` / `model` 的
//     JSDoc 重写：「"none" suits cheap judge/extract personas」改成「只在 ask 文本已含全部所需
//     时用 none；要核对文件、追引用、跑东西的用 readonly/default，无工具的子代理遇到那种 ask
//     会升级而不是假装」。起因是实盘 `tools:"none"` 的 GLM 子代理被要求核对磁盘内容后发出
//     `escalate("placeholder")`，见 docs/execution-engine.md与
//     docs/dynamic-workflow/authoring.md「The skill」。声明集（declare 行）不变。
//   - 23aef592…（2026-09-05）：上两条在两条分支上各自重钉；合并（dwf-visual-redesign ⇄
//     feat/dynamic-workflow）后两段散文同在，按合并结果重钉。声明集（declare 行）不变。
//   - b500809e…（2026-09-05）：**纯散文**——`artifact` 段的总说明重写为两条习惯：每个 run 发布
//     其**交付物**（用户要网页/PDF 就是那个文件走 file()；要的是结论就是报告的长版，通常是
//     markdown()；一行答案除外）、看板是给盯着 run 的人看的（只在有值得盯的中途状态时声明）；
//     外加两条「值不值一张卡」的检验（用户会单独打开吗、是否重复另一产物）。`markdown()` 的
//     JSDoc 由「不是 return 的复制」改成「报告型交付物的常见形态」。与 SKILL.md §9 /
//     examples.md 同批。声明集（declare 行）不变。
//   - f94af7c0…（2026-09-07）：**纯散文**——phase 段的命名规则加一句回声：「像告诉同事现在
//     在做什么那样说」，附一对中文正反例（"确认测试仍然通过"，不是 "执行测试验证任务"）。
//     同段重排行宽以守住 max-lines 400（模板字面量里的行算代码行，不算注释）。
//     教法从「三个禁用词」改为「一条原则 + 成对例子」（docs/dynamic-workflow/presentation.md
//     2026-09-07 裁决；完整例子表在 SKILL.md「Write for the user」一节）。声明集（declare 行）不变。
//   - 853ae664…（2026-09-11）：**动了声明集**——`declare type ModelTier` 与 `AgentPersona.model`
//     退场（docs/dynamic-workflow/authoring.md）：宿主没有 lite 模型来源，档位早已是
//     空转的旋钮，却仍占着 facade 的篇幅。子代理一律跑父会话当前模型。
//   - fe83dea7…（2026-09-11）：**动了声明集**——`ToolProfile` 收成 `"default" | "readonly"`，
//     `"none"` 退场（同一决策记录）：它比 readonly 多买到的只有「不去读文件」，而这靠 ask 文本
//     就能做到；它另外带来了唯一一族退化升级与三处按档位分支的提示。`ToolProfile` 与
//     `AgentPersona.tools` 的 JSDoc 同批改写为两档的说法。
//   - dee40f0b…（2026-09-12）：**动了声明集**——`declare type ToolProfile` 与 `AgentPersona.tools`
//     整个退场（同一决策记录，第二轮）：档位买到的只有「裁判不能改文件」，普通子代理也不靠
//     档位保证这一点，ask 文本说清即可；`AgentPersona` 只剩 `system`，JSDoc 说明每个 actor 都有
//     完整工作工具集。
//   - c19c9310…（2026-09-14）：只改一句 JSDoc——createActor 名字注释里的「CreateWorkflow with
//     resume_from」改为「AmendWorkflow」（修订入口拆成独立工具，docs/dynamic-workflow/launch.md）。
//   - 21cb21e1…（2026-09-14）：**动了声明集**——`ArtifactOptions.primary?: boolean`
//     （docs/dynamic-workflow/authoring.md「Ids, tags and versions」）：脚本标出 run 的交付物，完成卡与 run 侧板
//     以它带头。`description` 补 JSDoc（它现在会显示在交付物那一行旁边）；`artifact` 的散文加一句
//     「发布多于一件时给交付物标 primary」。
//   - abeaec0a…（2026-09-15）：合并 dwf-better-artifacts——上两条（AmendWorkflow JSDoc 与
//     `ArtifactOptions.primary`）同时在场，哈希取并集后的文本。
//   - 7478845e…（2026-09-22）：**动了声明集**——stream 段加入（docs/dynamic-workflow/authoring.md
//     「Streams」）：`Channel<T>`、`channel()`、`future()`，两个 facade 都含。段文本住在
//     facade/dts-stream.ts（dts.ts 顶在行数上限），仍由 dts.ts 拼接。
//   - 7fd6b30e…（2026-09-26）：**动了声明集**——子代理模型回到 persona（docs/dynamic-workflow/
//     authoring.md「Choosing a model per subagent」）：`ModelRef`（私有构造器的 class）、`model()`、
//     `AgentPersona.model?: ModelRef | string`。只在 actor 段，snippet 不含。
//   - 4f79960c…（2026-09-26）：只改一句 JSDoc——`report()` 的条数上限由 256 改为 65,536
//     （docs/execution-engine.md「Progressive results: `report`」与「Reading the journal」）。
//     声明集（declare 行）不变。
//   - 7f7dc6df…（2026-09-26）：只改一句 JSDoc——`report()` 的单条上限由 32KB 改为 1 MiB，并加上
//     run 级 1 GiB 的字节总数上限（docs/execution-engine.md「Progressive results: `report`」）。
//     声明集（declare 行）不变。
//   - a82956e9…（2026-09-26）：合并 dwf-report-limit——上三条（persona 的 `ModelRef`/`model()` 与
//     `report()` 两句上限 JSDoc）同时在场，哈希取并集后的文本。
//   - f1990146…（2026-09-28）：**动了声明集**——hole 段加入（docs/dynamic-workflow/authoring.md
//     「Holes: `hole<T>()`」）：`hole<T>(name, prompt?)` / `hole<T>(name, body)` /
//     `hole<T>(name, prompt, body)` 三个重载。段文本住在 facade/dts-hole.ts，拼在 phase 段之后；
//     **只进完整 facade**，snippet 不含（片段没有 run，也就没有可等主代理补全的东西）。
//   - b47c6183…（2026-09-28）：只改一句 JSDoc——hole 段的禁区收窄为「数组方法的 fan-out 回调」
//     （for...of 体允许：顺序循环里第一轮停在留白、补全后每轮跑函数体），并加上「函数体必须
//     内联」一句。声明集（declare 行）不变。
//   - 278970c4…（2026-09-30）：**纯散文**——注释收成参考层（docs/dynamic-workflow/authoring.md
//     「The facade」）：判断层（阶段怎么命名、交付物两条习惯、门控惯用法、流水线阶段的写法等）
//     删去，只留在技能正文里；其余注释按脚本作者的读法改写（actor → subagent、journaled → recorded、
//     hole 的读者就是主代理所以称「你」）；facade 23 275 → 13 598 字节。声明集（declare 行）不变。
const PINNED_FACADE_SHA256 = "278970c47a2b3e5225d8e993320193221b42bd524121228e363f84ee4654609d";

describe("facade dts segments", () => {
  it("FACADE_DTS is byte-identical to the pinned composition", () => {
    const hash = createHash("sha256").update(FACADE_DTS, "utf8").digest("hex");
    expect(hash).toBe(PINNED_FACADE_SHA256);
  });

  // 注释只写参考层：做什么、返回什么、何时拒绝或让 run 失败、上限、实参的编译期规则
  // （docs/dynamic-workflow/authoring.md「The facade」）。判断层在技能正文里只说一次；facade
  // 只经技能 §16.2 进上下文，注释复述正文等于每次写作会话付两遍，且是会漂移的那一份。
  // 2026-09-30 去重前是 23 275 字节，其中约 2 万是注释。
  it("stays a reference: FACADE_DTS is under 14 000 bytes", () => {
    expect(Buffer.byteLength(FACADE_DTS, "utf8")).toBeLessThan(14_000);
  });

  // args 在**两个** facade 里都在：snippet 的「逐字可迁移」不变式要求一段引用 args 的
  // saved 脚本能原样丢进 EvalWorkflowSnippet 编译（运行时它是 `{}`）。
  it("SNIPPET_FACADE_DTS keeps world reads, world.run, log and args, drops actors/report/artifact/phase", () => {
    expect(SNIPPET_FACADE_DTS).toContain("declare const args");
    expect(FACADE_DTS).toContain("declare const args");
    expect(SNIPPET_FACADE_DTS).toContain("declare const files");
    expect(SNIPPET_FACADE_DTS).toContain("declare const git");
    expect(SNIPPET_FACADE_DTS).toContain("declare const world");
    expect(SNIPPET_FACADE_DTS).toContain("declare function log");
    // stream 段在两个 facade 里都在：流水线的纯逻辑正是片段要排练的东西。
    expect(SNIPPET_FACADE_DTS).toContain("declare function channel");
    expect(SNIPPET_FACADE_DTS).toContain("declare function future");
    expect(SNIPPET_FACADE_DTS).toContain("declare interface Channel<T>");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function agent");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function report");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function phase");
    // 模型声明属于 actor：snippet 里没有子代理，也就没有可选的模型。
    expect(FACADE_DTS).toContain("declare function model");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function model");
    expect(SNIPPET_FACADE_DTS).not.toContain("ModelRef");
    // 产物是「run 交给用户的产出」，而 snippet 没有 run：整段刻意缺席，连类型都不留。
    expect(FACADE_DTS).toContain("declare const artifact");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare const artifact");
    expect(SNIPPET_FACADE_DTS).not.toContain("ArtifactRef");
    // 留白只在完整 facade 里（docs/dynamic-workflow/authoring.md「Holes」）：片段没有 run。
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, prompt?: string): Promise<T>;",
    );
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;",
    );
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;",
    );
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function hole");
  });

  it("rejects hole() in the snippet facade at compile time (TS2304)", () => {
    const workflow = createWorkflowProgram(`return await hole<string>("决定");`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'hole'");
  });

  // docs/dynamic-workflow/authoring.md「What the facade does not have」：脚本 facade 里没有 budget 标识符。
  it("neither facade declares budget", () => {
    expect(FACADE_DTS).not.toContain("budget");
    expect(SNIPPET_FACADE_DTS).not.toContain("budget");
  });
});

describe("snippet compilation (scratch facade)", () => {
  const compileSnippet = (scriptText: string) =>
    createWorkflowProgram(scriptText, { facadeDts: SNIPPET_FACADE_DTS });

  it("compiles a world-read + pure-logic snippet cleanly", () => {
    const workflow = compileSnippet(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `log(\`found \${paths.length}\`);\n` +
        `return paths.filter((p) => p.endsWith(".test.ts"));`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
  });

  it("rejects agent() at compile time (TS2304, not a runtime surprise)", () => {
    const workflow = compileSnippet(`return await agent("a").ask("do it");`);
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'agent'");
  });

  it("rejects report() and phase() the same way", () => {
    for (const source of [`report({ found: 1 });`, `phase("gate");`]) {
      const workflow = compileSnippet(source);
      expect(collectDiagnostics(workflow.program).length).toBeGreaterThan(0);
    }
  });

  // facade 身份按声明文件名判定（registry / sites / misuse / lowering 五处）；scratch
  // facade 若换了文件名，站点收集会静默变空、files.glob 不再降级到 __host.worldRead——
  // snippet 编译通过却什么都不做。这条钉住「同名注入」的不变量。
  it("lowers files.glob in a snippet to a world-read site (facade filename invariant)", () => {
    const workflow = compileSnippet(`return await files.glob("*.ts");`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain(`__host.worldRead("world-read#1", "glob"`);
  });
});

// 产物的**类型面**（docs/dynamic-workflow/authoring.md「Two families」）：两族成员的语义
// 不对称必须在类型上就成立——内容成员可 await 出 ArtifactRef，预置成员是 void。
describe("artifact facade (type surface)", () => {
  const diagnosticsOf = (scriptText: string) =>
    collectDiagnostics(createWorkflowProgram(scriptText).program);

  it("types content members as Promise<ArtifactRef>", () => {
    expect(
      diagnosticsOf(
        `const ref = await artifact.file("book", "out/book.pdf", { title: "Book", contentType: "application/pdf" });\n` +
          `const md = await artifact.markdown("notes", "# hi", { description: "d" });\n` +
          `return ref.id + String(ref.version) + md.id;`,
      ),
    ).toEqual([]);
  });

  it("rejects using a content member's result as anything but an ArtifactRef", () => {
    const diagnostics = diagnosticsOf(`const n: number = await artifact.file("book", "b.pdf");`);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("not assignable");
  });

  it("types preset members as void (a declaration has nothing to await)", () => {
    expect(
      diagnosticsOf(
        `artifact.chart("perf", { type: "line", x: { field: "round" }, y: [{ field: "ms", label: "ms" }], scale: "log", baseline: { field: "budget" } });\n` +
          `artifact.table("rows", { columns: [{ field: "name" }], key: "name" });\n` +
          `artifact.metrics("m", { metrics: [{ field: "p95", unit: "ms" }] });\n` +
          `artifact.board("b", { key: "id", status: "state", columns: ["todo", "done"], detail: [{ field: "owner" }] });`,
      ),
    ).toEqual([]);
    const diagnostics = diagnosticsOf(
      `const v: number = artifact.chart("perf", { x: { field: "r" }, y: { field: "m" } });`,
    );
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("lets a board name itself and its cards separately (the cardTitle rename)", () => {
    expect(
      diagnosticsOf(
        `artifact.board("b", { title: "内存回归", key: "id", status: "state", columns: ["todo"], cardTitle: "name" });`,
      ),
    ).toEqual([]);
    // 旧名字不再是 BoardSpec 的字段名之外的东西：写 title 就是给板子起名，不是给卡片取标题。
    expect(FACADE_DTS).toContain("cardTitle?: string");
  });

  it("accepts primary on every member and rejects a non-boolean one", () => {
    expect(
      diagnosticsOf(
        `await artifact.file("book", "b.pdf", { primary: true });\n` +
          `await artifact.markdown("notes", "# hi", { title: "Notes", primary: false });\n` +
          `artifact.board("b", { key: "id", status: "state", columns: ["todo"], primary: true });`,
      ),
    ).toEqual([]);
    expect(
      diagnosticsOf(`await artifact.file("book", "b.pdf", { primary: "yes" });`).length,
    ).toBeGreaterThan(0);
    expect(FACADE_DTS).toContain("primary?: boolean");
  });

  it("rejects a malformed spec at compile time (missing y, wrong chart type)", () => {
    expect(diagnosticsOf(`artifact.chart("perf", { x: { field: "r" } });`).length).toBeGreaterThan(
      0,
    );
    expect(
      diagnosticsOf(
        `artifact.chart("perf", { x: { field: "r" }, y: { field: "m" }, type: "pie" });`,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("makes report's second argument an optional string", () => {
    expect(diagnosticsOf(`report({ a: 1 });\nreport({ a: 1 }, "perf");`)).toEqual([]);
    expect(diagnosticsOf(`report({ a: 1 }, 1);`).length).toBeGreaterThan(0);
  });

  it("leaves artifact out of the snippet facade (TS2304, not a runtime surprise)", () => {
    const workflow = createWorkflowProgram(`await artifact.file("book", "b.pdf");`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'artifact'");
  });
});

describe("world.run (compile side)", () => {
  it("typechecks and lowers to the run op with positional args", () => {
    const workflow = createWorkflowProgram(
      `const r = await world.run("lean", ["--make", "proof.lean"], { timeoutMs: 60000 });\n` +
        `return r.exitCode === 0;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain(`__host.worldRead("world-read#1", "run"`);
  });

  it("collects the deduplicated, sorted command set from literals", () => {
    const workflow = createWorkflowProgram(
      `await world.run("node", ["-e", "0"]);\n` +
        `await world.run(\`lean\`, ["a.lean"]);\n` +
        `await world.run("node", ["-e", "1"]);`,
    );
    const table = collectSites(workflow);
    const { commands, diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toEqual([]);
    expect(commands).toEqual(["lean", "node"]);
  });

  it("rejects a non-literal cmd with a positioned WORLD_RUN_LITERAL_CODE diagnostic", () => {
    const workflow = createWorkflowProgram(
      `const cmd = "lean";\nconst r = await world.run(cmd, []);\nreturn r.exitCode;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const { diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(WORLD_RUN_LITERAL_CODE);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toContain("string literal");
    // analyzeWorkflowScript 把它与 misuse 同席（ok:false）。
    const analyzed = analyzeWorkflowScript(
      `const cmd = "lean";\nconst r = await world.run(cmd, []);\nreturn r.exitCode;`,
    );
    expect(analyzed.ok).toBe(false);
    expect(analyzed.diagnostics[0]?.code).toBe(WORLD_RUN_LITERAL_CODE);
  });

  it("rejects a substitution template cmd", () => {
    const workflow = createWorkflowProgram(
      `const suffix = "n";\nawait world.run(\`lea\${suffix}\`, []);`,
    );
    const table = collectSites(workflow);
    const { diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toHaveLength(1);
  });

  it("keeps the world.run step label carrying the command (confirmation surface)", () => {
    const analyzed = analyzeWorkflowScript(`await world.run("lean", ["a.lean"]);`);
    expect(analyzed.ok).toBe(true);
    const step = analyzed.causality?.steps.find((s) => s.label.includes("lean"));
    expect(step).toBeDefined();
    expect(step?.label).toBe("run lean");
  });
});

// args 的降级（docs/dynamic-workflow/launch.md「Running a saved workflow」）：
// 它是 facade 里唯一一个**值**而不是可调用物，所以走标识符级改写而不是站点。
describe("args lowering", () => {
  it("lowers a facade args read to __host.args, with no site of its own", () => {
    const workflow = createWorkflowProgram(`const target = String(args.target);\nreturn target;`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain("__host.args.target");
    // 读一个值不是等待点：它不占 site id，也就不会长出因果图节点。
    expect(lowered.siteIds).toEqual([]);
  });

  it("lowers args in the snippet facade too (verbatim portability)", () => {
    const workflow = createWorkflowProgram(`return String(args.x);`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).toContain("__host.args.x");
  });

  // 判定按 checker 解析结果，不按名字：脚本自己声明的 args 解析到脚本文件的符号。
  // 名字启发式会把这段改写成 `const __host.args = ...`，一个运行期 SyntaxError。
  it("leaves a script-declared local `args` alone", () => {
    const workflow = createWorkflowProgram(`const args = { local: 1 };\nreturn args.local;`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).not.toContain("__host.args");
    expect(lowered.code).toContain("args.local");
  });

  it("leaves a parameter named args and an unrelated `.args` property alone", () => {
    const workflow = createWorkflowProgram(
      [
        "function pick(args: { a: number }): number { return args.a; }",
        "const holder = { args: 7 };",
        "return pick({ a: 1 }) + holder.args;",
      ].join("\n"),
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).not.toContain("__host.args");
  });

  // 一段同时用 args 和 ask 的脚本：改写不能破坏站点，站点也不能吞掉 args。
  it("coexists with ask sites", () => {
    const workflow = createWorkflowProgram(
      `const r = await agent("w").ask(String(args.topic));\nreturn r;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain("__host.args.topic");
    expect(lowered.code).toContain('__host.ask("ask#1"');
  });
});
