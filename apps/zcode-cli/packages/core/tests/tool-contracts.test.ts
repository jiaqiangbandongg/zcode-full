import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentInputSchema, BashInputJsonSchema, BashOutputJsonSchema } from "@zcode/contracts";
import { agentToolEntry } from "../src/tool/handlers/agent.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { editToolEntry } from "../src/tool/handlers/edit.js";
import { globToolEntry } from "../src/tool/handlers/glob.js";
import { grepToolEntry } from "../src/tool/handlers/grep.js";
import { builtInTools, registerBuiltInTools } from "../src/tool/handlers/index.js";
import { addReadLineNumbers, readToolEntry } from "../src/tool/handlers/read.js";
import { sendMessageToolEntry } from "../src/tool/handlers/send-message.js";
import { orderProviderVisibleToolContracts } from "../src/tool/provider-visible-order.js";
import { writeToolEntry } from "../src/tool/handlers/write.js";
import { formatTaskNotification } from "../src/runtime-task/notification.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { buildExploreSystemPrompt } from "../src/subagent/explore.js";

const testDirname = dirname(fileURLToPath(import.meta.url));

function normalizeWebSearchDynamicDate(description: string | undefined): string {
  return (description ?? "").replace(
    /The current month is [A-Z][a-z]+ \d{4}/u,
    "The current month is <current-month>",
  );
}

const DIRECT_BRANCH_REFERENCE_SEARCH_DESCRIPTIONS = {
  Glob: 'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.',
  Grep: `Content search built on ripgrep. Prefer this over \`grep\`/\`rg\` via Bash — results integrate with the permission UI and file links.

- Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"). Ripgrep, not grep — escape literal braces (\`interface\\{\\}\`).
- Filter with \`glob\` (e.g. "**/*.tsx") or \`type\` (e.g. "js", "py", "rust").
- \`output_mode\`: "content" (matching lines), "files_with_matches" (paths only, default), or "count".
- \`multiline: true\` for patterns that span lines.`,
} as const;

const DIRECT_BRANCH_EXPECTED_PROVIDER_TOOL_ORDER = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "Read",
  "Skill",
  "TaskOutput",
  "TaskStop",
  "TodoRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
  "SendMessage",
  "ReadSessionContext",
  "ReplyToChannel",
  "CreateWorkflow",
  // 修订入口紧随 CreateWorkflow 注册（docs/dynamic-workflow/launch.md「The `AmendWorkflow` tool」）。
  "AmendWorkflow",
  "SaveWorkflow",
  "EvalWorkflowSnippet",
  // run 内省与定义清单四个工具都不进 SORTED_PROVIDER_TOOL_NAMES（与 CreateWorkflow 同规），
  // 所以按注册序排在尾部。ResumeWorkflowRun 插在 GetWorkflowRun 之后（run 工具簇相邻）。
  "ListWorkflowRuns",
  "GetWorkflowRun",
  "ResumeWorkflowRun",
  // 升级问答的主代理侧（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）：同为无 gate 的主会话工具，
  // 紧随 run 工具簇——它读的正是那些 run 上停驻的问题。
  "ResolveWorkflowQuestion",
  // 留白补全（docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」）：alwaysAsk 门的主会话工具，
  // 按注册序紧随 ResolveWorkflowQuestion。
  "FillWorkflowHole",
  "ListSavedWorkflows",
  // 模型目录（docs/dynamic-workflow/launch.md）：同样不进 SORTED_PROVIDER_TOOL_NAMES，
  // 所以按注册序排在定义清单之后。
  "ListModels",
] as const;

const EMBEDDED_SEARCH_EXPECTED_PROVIDER_TOOL_ORDER =
  DIRECT_BRANCH_EXPECTED_PROVIDER_TOOL_ORDER.filter(
    (toolName) => toolName !== "Glob" && toolName !== "Grep",
  );

const SOURCE_DERIVED_WEBFETCH_DESCRIPTION = [
  "Fetches a URL, converts the page to markdown, and answers `prompt` against it using a small fast model.",
  "",
  "- Fails on authenticated/private URLs — use an authenticated MCP tool or `gh` for those instead.",
  "- HTTP is upgraded to HTTPS. Cross-host redirects are returned to you rather than followed; call again with the redirect URL.",
  "- Responses are cached for 15 minutes per URL.",
].join("\n");

const SOURCE_DERIVED_READ_SHORT_DESCRIPTION = [
  "Reads a file from the local filesystem.",
  "",
  "- `file_path` must be an absolute path.",
  "- Reads up to 2000 lines by default.",
  "- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters",
  "- Results are returned using cat -n format, with line numbers starting at 1",
  "- Reads images (PNG, JPG, …) and presents them visually.",
  // video 输入一期新增能力行：Read 支持读取视频作为模型输入。
  "- Reads videos (MP4, MOV, WEBM, …) and presents them as video input (subject to ZCode's video input limit).",
  "- Reading a directory, a missing file, or an empty file returns an error or system reminder rather than content.",
  "- Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.",
].join("\n");

const SOURCE_DERIVED_SEND_MESSAGE_DESCRIPTION = [
  "# SendMessage",
  "",
  "Send a message to another agent.",
  "",
  "```json",
  '{"to": "agent_<uuid>", "summary": "assign task 1", "message": "start on task #1"}',
  "```",
  "",
  "Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from agents are delivered automatically; you don't check an inbox. Refer to local agents by the `agentId` returned in the Agent spawn result. To resume a completed agent, use its `agentId`; it resumes in the background and you'll be notified when it finishes.",
].join("\n");

function getSchemaPath(schema: unknown, path: readonly string[]): unknown {
  let current = schema;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

describe("tool contract declarations", () => {
  it("orders shared provider-visible tool contracts by source name sort before appending local-only tools", () => {
    const directRegistry = createToolRegistry();
    registerBuiltInTools(directRegistry, {
      includeAgent: true,
      includeSendMessage: true,
      includeSkill: true,
    });
    expect(directRegistry.list().slice(0, 3)).toEqual(["Read", "Write", "Edit"]);
    expect(
      orderProviderVisibleToolContracts(directRegistry.toContracts()).map((tool) => tool.name),
    ).toEqual(DIRECT_BRANCH_EXPECTED_PROVIDER_TOOL_ORDER);

    const embeddedRegistry = createToolRegistry();
    registerBuiltInTools(embeddedRegistry, {
      embeddedSearchEnabled: true,
      includeAgent: true,
      includeSendMessage: true,
      includeSkill: true,
    });
    expect(
      orderProviderVisibleToolContracts(embeddedRegistry.toContracts()).map((tool) => tool.name),
    ).toEqual(EMBEDDED_SEARCH_EXPECTED_PROVIDER_TOOL_ORDER);
  });

  it("orders shared provider tools before preserving local-only relative order", () => {
    expect(
      orderProviderVisibleToolContracts([
        { name: "TodoWrite" },
        { name: "Bash" },
        { name: "TodoRead" },
        { name: "Task" },
        { name: "Read" },
        { name: "ReadSessionContext" },
      ]).map((tool) => tool.name),
    ).toEqual(["Bash", "Read", "TodoRead", "TodoWrite", "Task", "ReadSessionContext"]);
  });

  it("orders optional Workflow with the shared provider tool partition when it is present", () => {
    expect(
      orderProviderVisibleToolContracts([
        { name: "Write" },
        { name: "Workflow" },
        { name: "ReadSessionContext" },
        { name: "WebSearch" },
      ]).map((tool) => tool.name),
    ).toEqual(["WebSearch", "Workflow", "Write", "ReadSessionContext"]);
  });

  it("matches source-derived provider-visible schema facts for supported tools", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      embeddedSearchEnabled: true,
      includeAgent: true,
      includeSkill: true,
    });

    const byName = new Map(registry.toContracts().map((tool) => [tool.name, tool]));
    const cases: Array<{ toolName: string; path: readonly string[]; expected: unknown }> = [
      {
        toolName: "AskUserQuestion",
        path: ["properties", "questions", "minItems"],
        expected: 1,
      },
      {
        toolName: "AskUserQuestion",
        path: ["properties", "questions", "maxItems"],
        expected: 4,
      },
      {
        toolName: "AskUserQuestion",
        path: ["properties", "questions", "items", "required"],
        expected: ["question", "header", "options", "multiSelect"],
      },
      {
        toolName: "AskUserQuestion",
        path: ["properties", "questions", "items", "properties", "multiSelect", "default"],
        expected: false,
      },
      {
        toolName: "AskUserQuestion",
        path: ["properties", "questions", "items", "properties", "multiSelect", "description"],
        expected:
          "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
      },
      {
        toolName: "WebFetch",
        path: ["properties", "url", "description"],
        expected: "The URL to fetch content from",
      },
      {
        toolName: "WebFetch",
        path: ["properties", "prompt", "description"],
        expected: "The prompt to run on the fetched content",
      },
      {
        toolName: "WebSearch",
        path: ["properties", "query", "minLength"],
        expected: 2,
      },
      {
        toolName: "WebSearch",
        path: ["properties", "allowed_domains", "items", "type"],
        expected: "string",
      },
      {
        toolName: "WebSearch",
        path: ["properties", "allowed_domains", "maxItems"],
        expected: undefined,
      },
      {
        toolName: "WebSearch",
        path: ["properties", "blocked_domains", "items", "type"],
        expected: "string",
      },
      {
        toolName: "WebSearch",
        path: ["properties", "blocked_domains", "maxItems"],
        expected: undefined,
      },
    ];

    for (const { toolName, path, expected } of cases) {
      expect(
        getSchemaPath(byName.get(toolName)?.inputSchema, path),
        `${toolName}.${path.join(".")}`,
      ).toEqual(expected);
    }
  });

  it("keeps ExitPlanMode guidance aligned with the current plan parameter contract", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);
    const description =
      registry.toContracts().find((contract) => contract.name === "ExitPlanMode")?.description ??
      "";

    expect(description).toContain("DOES take the plan content as the required plan parameter");
    expect(description).toContain("use AskUserQuestion before finalizing your plan");
    expect(description).toContain("ExitPlanMode inherently requests user approval");
    expect(description).not.toContain("yolo");
    expect(description).not.toContain("read the plan from the file");
    expect(description).toMatch(/\n$/u);
  });

  it("uses the concise Read description lines for range and line-number guidance", () => {
    expect(readToolEntry.metadata.description).toBe(SOURCE_DERIVED_READ_SHORT_DESCRIPTION);
    expect(readToolEntry.metadata.description).not.toContain(
      "Each line is the line number, a single separator (a tab), then the verbatim file content",
    );
  });

  it("matches direct short Glob and Grep provider contracts exactly", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);
    const byName = new Map(registry.toContracts().map((tool) => [tool.name, tool]));

    for (const toolName of ["Glob", "Grep"] as const) {
      expect(byName.get(toolName)?.description, `${toolName}.description`).toBe(
        DIRECT_BRANCH_REFERENCE_SEARCH_DESCRIPTIONS[toolName],
      );
    }
  });

  it("matches the SendMessage prompt for the supported local-agent subset", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeSendMessage: true });
    const contract = registry.toContracts().find((tool) => tool.name === "SendMessage");

    expect(contract?.description).toBe(SOURCE_DERIVED_SEND_MESSAGE_DESCRIPTION);
    expect(contract?.description).not.toContain("Usage:");
    expect(contract?.description).not.toContain("shutdown_request");
    expect(contract?.description).not.toContain("teammate");
    expect(getSchemaPath(contract?.inputSchema, ["required"])).toEqual([
      "to",
      "summary",
      "message",
    ]);
    expect(getSchemaPath(contract?.inputSchema, ["additionalProperties"])).toBe(false);
    expect(getSchemaPath(contract?.inputSchema, ["properties", "to", "description"])).toBe(
      "Recipient: local agent ID returned by Agent (format agent_<uuid>).",
    );
    expect(getSchemaPath(contract?.inputSchema, ["properties", "summary", "description"])).toBe(
      "A 5-10 word summary shown as a preview in the UI.",
    );
    expect(getSchemaPath(contract?.inputSchema, ["properties", "message", "description"])).toBe(
      "Plain text message content",
    );
  });

  it("projects supported provider schema differences from the primary input schema", () => {
    const contractToolsDir = resolve(testDirname, "../../contracts/src/tools");
    const files = [
      "agent.ts",
      "ask-user-question.ts",
      "bash.ts",
      "edit.ts",
      "json-schema.ts",
      "plan-mode.ts",
      "skill.ts",
      "webfetch.ts",
    ];

    for (const file of files) {
      const source = readFileSync(resolve(contractToolsDir, file), "utf8");
      expect(source, file).not.toContain("deleteToolJsonSchemaKeys");
      expect(source, file).not.toContain("setToolJsonSchemaValue");
      expect(source, file).not.toContain("getToolJsonSchemaNode");
    }

    for (const file of files.filter((file) => file !== "json-schema.ts")) {
      const source = readFileSync(resolve(contractToolsDir, file), "utf8");
      expect(source, file).not.toContain("ProviderInputSchema");
      expect(source, file).not.toContain("InputJsonSchema = {");
      expect(source, file).not.toContain("satisfies JsonSchema");
      expect(source, file).not.toContain("superRefine(nonEmptyString");
      expect(source, file).not.toContain("superRefine(maxLength");
      expect(source, file).not.toContain("superRefine(maxItems");
      expect(source, file).not.toContain("superRefine(noUnexpectedKeys");
      expect(source, file).not.toContain("validateBashTimeout");
    }
  });

  it("requires every built-in tool to declare the v2 common contract", () => {
    for (const entry of builtInTools) {
      expect(entry.capability, entry.metadata.name).toBeTruthy();
      expect(entry.inputSchema, entry.metadata.name).toEqual(expect.any(Object));
      expect(entry.outputSchema, entry.metadata.name).toEqual(expect.any(Object));
      expect(entry.runtimeInputSchema, entry.metadata.name).toBeTruthy();
      expect(entry.runtimeOutputSchema, entry.metadata.name).toBeTruthy();
      expect(entry.permission.permission, entry.metadata.name).toBeTruthy();
      expect(entry.permission.reason, entry.metadata.name).toBeTruthy();
      expect(entry.permission.riskLevel, entry.metadata.name).toBe(entry.metadata.riskLevel);
      expect(entry.permission.sideEffectScope, entry.metadata.name).toBe(
        entry.metadata.sideEffectScope,
      );
      expect(entry.resultBudget.maxInlineBytes, entry.metadata.name).toBeGreaterThan(0);
      expect(entry.resultBudget.maxModelBytes, entry.metadata.name).toBeGreaterThan(0);
      if (entry.timeout.kind === "none") {
        expect(entry.metadata.timeoutMs, entry.metadata.name).toBeUndefined();
      } else {
        expect(entry.timeout.defaultMs, entry.metadata.name).toBe(entry.metadata.timeoutMs);
      }
      expect(entry.cancellation.userVisibleMessage, entry.metadata.name).toBeTruthy();
      expect(entry.trace.required, entry.metadata.name).toBe(true);
    }
  });

  it("keeps Bash background fields in provider schemas without exposing execution internals", () => {
    expect(BashOutputJsonSchema.properties).toHaveProperty("backgroundTaskId");
    expect(BashOutputJsonSchema.properties).toHaveProperty("assistantAutoBackgrounded");
    expect(BashInputJsonSchema.properties).toHaveProperty("run_in_background");
  });

  it("keeps local provider output schemas out of contracts runtime exports", () => {
    const coreHandlersDir = resolve(testDirname, "../src/tool/handlers");
    const agentSource = readFileSync(resolve(coreHandlersDir, "agent.ts"), "utf8");
    const sendMessageSource = readFileSync(resolve(coreHandlersDir, "send-message.ts"), "utf8");

    expect(agentSource).not.toContain("AgentProviderOutputJsonSchema");
    expect(sendMessageSource).not.toContain("SendMessageProviderOutputJsonSchema");
  });

  it("projects output schema and runtime-only declarations into model contracts", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      includeAgent: true,
      includeSendMessage: true,
      includeWorkflow: true,
    });

    const contracts = registry.toContracts();
    const byName = new Map(contracts.map((contract) => [contract.name, contract]));

    expect(byName.get("Agent")?.outputSchema).toBeDefined();
    expect(byName.get("Agent")?.inputSchema).not.toHaveProperty("properties.subagent_type.enum");
    expect(byName.get("Agent")?.inputSchema).not.toHaveProperty("properties.model");
    expect(byName.get("Agent")?.inputSchema).toHaveProperty("properties.run_in_background.type");
    expect(byName.get("Agent")?.permission?.sideEffectScope).toBe("session");

    const agentDescription = byName.get("Agent")?.description ?? "";
    const normalizedAgentDescription = agentDescription.replace(/\s+/gu, " ");
    expect(agentDescription).toContain(
      "Use SendMessage with the agent's ID to continue a previously spawned agent with its context intact; a new Agent call starts fresh.",
    );
    expect(agentDescription).toContain(
      "Each agent type's model, reasoning effort, and tools come from its definition (`.zcode/agents/*.md` frontmatter).",
    );
    expect(agentDescription).not.toContain("ID or name");
    expect(agentDescription).not.toContain(".claude/agents");
    expect(agentDescription).not.toContain("When you launch multiple agents for independent work");
    expect(agentDescription).toContain("Available agent types are listed in <system-reminder> messages in the conversation.");
    expect(agentDescription).not.toContain("- general-purpose:");
    expect(agentDescription).not.toContain("- Explore:");
    expect(agentDescription).not.toContain("model:");
    expect(agentDescription).not.toContain("(background: true)");
    expect(normalizedAgentDescription).not.toContain("## Usage notes");
    expect(normalizedAgentDescription).not.toContain("## When not to use");
    expect(normalizedAgentDescription).not.toContain("Trust but verify");
    expect(normalizedAgentDescription).not.toContain("Foreground vs background");
    expect(normalizedAgentDescription).not.toContain("Example usage");
    expect(byName.get("Agent")?.inputSchema).not.toHaveProperty("properties.isolation");
    expect(byName.get("Read")?.outputSchema).toBeDefined();
    expect(byName.get("Read")?.capability).toContain("Read");
    expect(byName.get("Read")?.description).toBe(SOURCE_DERIVED_READ_SHORT_DESCRIPTION);
    expect(byName.get("Read")?.description).not.toContain("Usage:");
    expect(byName.get("Read")?.description).not.toContain("GB2312");
    expect(byName.get("Read")?.description).not.toContain("PDF");
    expect(byName.get("Read")?.description).not.toContain("Jupyter");
    expect(byName.get("Read")?.description).not.toContain("pages");
    expect(byName.get("Read")?.description).not.toContain("To find files use Glob");
    expect(byName.get("Glob")?.permission?.permission).toBe("read");
    expect(byName.get("Glob")?.description).toContain("Fast file pattern matching.");
    expect(byName.get("Glob")?.description).toContain('glob patterns like "**/*.js"');
    expect(byName.get("Glob")?.description).toContain("sorted by modification time");
    expect(byName.get("Glob")?.description).not.toContain("from the main agent");
    expect(byName.get("Grep")?.inputSchema).toHaveProperty("properties.pattern");
    expect(byName.get("Grep")?.description).toContain("ripgrep");
    expect(byName.get("Grep")?.description).toContain("Prefer this over `grep`/`rg` via Bash");
    expect(byName.get("Grep")?.description).toContain("Full regex syntax");
    expect(byName.get("Grep")?.description).toContain("files_with_matches");
    expect(byName.get("Grep")?.description).not.toContain("from the main agent");
    expect(byName.get("WebFetch")?.permission?.sideEffectScope).toBe("network");
    expect(byName.get("WebFetch")?.needsApproval).toBe(true);
    expect(byName.get("WebFetch")?.description).toBe(SOURCE_DERIVED_WEBFETCH_DESCRIPTION);
    expect(normalizeWebSearchDynamicDate(byName.get("WebSearch")?.description)).toContain(
      "Search the web. Returns result blocks with titles and URLs. US-only.",
    );
    expect(byName.get("TodoRead")?.permission?.sideEffectScope).toBe("none");
    expect(byName.get("TodoWrite")?.permission?.sideEffectScope).toBe("session");
    expect(byName.get("AskUserQuestion")?.requiresUserInteraction).toBe(true);
    expect(byName.get("AskUserQuestion")?.permission?.sideEffectScope).toBe("userInteraction");
    expect(byName.get("AskUserQuestion")?.description).toContain("Preview feature");
    expect(byName.get("AskUserQuestion")?.description).toContain("multiSelect");
    expect(byName.get("EnterPlanMode")?.requiresUserInteraction).toBe(false);
    expect(byName.get("EnterPlanMode")?.permission?.sideEffectScope).toBe("session");
    expect(byName.get("EnterPlanMode")?.permission?.needsApproval).toBe(false);
    const enterPlanDescription = byName.get("EnterPlanMode")?.description ?? "";
    expect(enterPlanDescription).toContain(
      "1. Thoroughly explore the codebase using Glob, Grep, and Read",
    );
    expect(enterPlanDescription).not.toContain("`find`/Glob");
    expect(enterPlanDescription).not.toContain("`grep`/Grep");
    expect(byName.get("ExitPlanMode")?.requiresUserInteraction).toBe(true);
    expect(byName.get("ExitPlanMode")?.permission?.sideEffectScope).toBe("session");
    expect(byName.get("ExitPlanMode")?.inputSchema).toHaveProperty("properties.plan");
    expect(byName.get("ExitPlanMode")?.inputSchema).not.toHaveProperty("properties.planFilePath");
    expect(byName.get("ExitPlanMode")?.inputSchema).not.toHaveProperty("properties.filePath");
    expect(byName.get("ExitPlanMode")?.description).toContain("## How This Tool Works");
    expect(byName.get("ExitPlanMode")?.description).not.toContain("Usage:");
    expect(byName.get("ExitPlanMode")?.description).toMatch(
      /^Use this tool when you are in plan mode/u,
    );
    expect(byName.get("ExitPlanMode")?.description).toContain(
      "DOES take the plan content as the required plan parameter",
    );
    expect(byName.get("ExitPlanMode")?.description).toContain("research tasks");
    expect(byName.get("ExitPlanMode")?.description).toContain(
      "Search for and understand the implementation of vim mode",
    );
    expect(byName.get("ExitPlanMode")?.description).toContain("AskUserQuestion");
    expect(byName.get("ExitPlanMode")?.description).toContain(
      "use AskUserQuestion before finalizing your plan",
    );
    expect(byName.get("ExitPlanMode")?.description).not.toContain("yolo");
    expect(byName.get("ExitPlanMode")?.description).toMatch(/\n$/u);
    expect(byName.get("SendMessage")?.permission?.sideEffectScope).toBe("session");
    expect(byName.get("SendMessage")?.description).toContain("local agent");
    expect(byName.get("Write")?.permission?.permission).toBe("edit");
    expect(byName.get("Write")?.description).toContain("Writes a file to the local filesystem");
    const applyPatch = byName.get("ApplyPatch");
    if (applyPatch) {
      expect(applyPatch.permission?.permission).toBe("edit");
      expect(applyPatch.description).toContain("structured file patches");
      expect(applyPatch.description).toContain("do not switch to Python");
      expect(applyPatch.description).toContain("GB2312");
    }
    expect(byName.get("Edit")?.description).toContain("Performs exact string replacement");
    expect(byName.get("Bash")?.resultBudget?.strategy).toBe("artifact");
    expect(byName.get("Bash")?.description).toBe(
      [
        "Executes a bash command and returns its output.",
        "",
        "- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
        "- IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.",
        "- `timeout` is in milliseconds: default 120000, max 600000.",
        "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
        "",
        "# Git",
        "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
        "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
        "- Commit or push only when the user asks. If on the default branch, branch first.",
      ].join("\n"),
    );
    expect(byName.get("Skill")?.description).toContain("available skills");
    expect(byName.get("Skill")?.inputSchema).not.toHaveProperty("_def");
    const workflow = byName.get("Workflow");
    if (workflow) {
      expect(workflow.description).toContain("workflow");
      const workflowSchema = workflow.inputSchema as any;
      for (const field of [
        "args",
        "description",
        "name",
        "resumeFromRunId",
        "script",
        "scriptPath",
        "title",
      ]) {
        expect(workflowSchema.properties?.[field]?.description).toEqual(expect.any(String));
      }
    }
  });

  it("keeps local-agent runtime fields out of provider-visible Agent output schema", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      includeAgent: true,
    });

    const byName = new Map(registry.toContracts().map((tool) => [tool.name, tool]));
    const agentOutputSchema = byName.get("Agent")?.outputSchema as any;
    const asyncSchema = (agentOutputSchema?.oneOf ?? agentOutputSchema?.anyOf)?.find(
      (candidate: any) => candidate?.properties?.status?.const === "async_launched",
    );
    const providerOutputSchema = JSON.stringify(asyncSchema);

    expect(providerOutputSchema).toContain("canReadOutputFile");
    expect(providerOutputSchema).not.toContain("isAsync");
    expect(providerOutputSchema).not.toContain("agentType");
    expect(providerOutputSchema).not.toContain("childSessionId");
    expect(providerOutputSchema).not.toContain("backgroundTaskId");
  });

  it("formats Agent tool results with local-agent continuation guidance", () => {
    const asyncContent = String(
      agentToolEntry.formatModelContent?.({
        status: "async_launched",
        isAsync: true,
        agentId: "agent_async",
        agentType: "Explore",
        description: "scan cache",
        prompt: "scan cache boundaries",
        childSessionId: "sess_child",
        backgroundTaskId: "agent_async",
        outputFile: "/tmp/agent_async/output.txt",
        canReadOutputFile: true,
      }),
    );

    expect(asyncContent).toContain("Async agent launched successfully.");
    expect(asyncContent).toContain(
      "agentId: agent_async (internal ID - do not mention to user. Use SendMessage with to: 'agent_async' to continue this agent.)",
    );
    expect(asyncContent).toContain("The agent is working in the background.");
    expect(asyncContent).toContain("output_file: /tmp/agent_async/output.txt");
    expect(asyncContent).toContain("Do NOT Read or tail this file via the shell tool");
    expect(asyncContent).not.toContain("Agent Explore task");

    const completedContent = String(
      agentToolEntry.formatModelContent?.({
        status: "completed",
        agentId: "agent_done",
        agentType: "code-reviewer",
        description: "review diff",
        prompt: "review the diff",
        content: [{ type: "text", text: "Found one issue." }],
        totalToolUseCount: 2,
        totalDurationMs: 33,
        totalTokens: 11,
      }),
    );

    expect(completedContent).toContain("Found one issue.");
    expect(completedContent).toContain(
      "agentId: agent_done (use SendMessage with to: 'agent_done' to continue this agent)",
    );
    expect(completedContent).toContain("<usage>subagent_tokens: 11");
    expect(completedContent).toContain("tool_uses: 2");
    expect(completedContent).toContain("duration_ms: 33</usage>");
  });

  it("omits subagent token usage when Agent completed usage is unavailable", () => {
    const completedContent = String(
      agentToolEntry.formatModelContent?.({
        status: "completed",
        agentId: "agent_done",
        agentType: "code-reviewer",
        description: "review diff",
        prompt: "review the diff",
        content: [{ type: "text", text: "Found one issue." }],
        totalToolUseCount: 2,
        totalDurationMs: 33,
      }),
    );

    expect(completedContent).toContain("Found one issue.");
    expect(completedContent).toContain("agentId: agent_done");
    expect(completedContent).not.toContain("subagent_tokens");
    expect(completedContent).toContain("<usage>tool_uses: 2");
    expect(completedContent).toContain("duration_ms: 33</usage>");
  });

  it("uses a no-output placeholder when Agent completed content is empty", () => {
    const completedContent = String(
      agentToolEntry.formatModelContent?.({
        status: "completed",
        agentId: "agent_done",
        agentType: "code-reviewer",
        description: "review diff",
        prompt: "review the diff",
        content: [{ type: "text", text: "" }],
        totalToolUseCount: 0,
        totalDurationMs: 33,
      }),
    );

    expect(completedContent).toMatch(/^\(Subagent completed but returned no output\.\)\n/);
    expect(completedContent).toContain("agentId: agent_done");
    expect(completedContent).toContain("<usage>tool_uses: 0");
  });

  it("derives Agent output-file readability from the parent provider-visible tool surface", async () => {
    const launches: Array<Record<string, unknown>> = [];
    const baseContext = {
      abortSignal: new AbortController().signal,
      sessionId: "sess_parent",
      toolCallId: "toolu_agent",
      traceId: "trace_parent",
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
      subagentPort: {
        async launch(request: Record<string, unknown>) {
          launches.push(request);
          return {
            status: "async_launched",
            isAsync: true,
            agentId: "agent_async",
            agentType: "Explore",
            description: "scan cache",
            prompt: "scan cache",
            childSessionId: "sess_child",
            backgroundTaskId: "agent_async",
            outputFile: "/tmp/agent_async/output.txt",
            canReadOutputFile: request.callerCanReadOutputFile === true,
          };
        },
      },
    };

    await agentToolEntry.handler(
      {
        description: "scan cache",
        prompt: "scan cache",
        run_in_background: true,
      },
      {
        ...baseContext,
        providerVisibleToolNames: ["Agent", "SendMessage"],
      } as any,
    );
    await agentToolEntry.handler(
      {
        description: "scan cache",
        prompt: "scan cache",
        run_in_background: true,
      },
      {
        ...baseContext,
        providerVisibleToolNames: ["Agent", "Read"],
      } as any,
    );

    expect(launches[0]?.callerCanReadOutputFile).toBe(false);
    expect(launches[1]?.callerCanReadOutputFile).toBe(true);
  });

  it("passes the active Loop Model to an Agent child that has no execution override", async () => {
    const launchOptions: Array<Record<string, unknown> | undefined> = [];
    const activeModel = {
      providerId: "provider-a",
      modelId: "model-a",
      properties: {},
      optionSpecs: {},
      options: {},
    };

    await agentToolEntry.handler(
      {
        description: "review current loop",
        prompt: "inherit the parent model",
      },
      {
        abortSignal: new AbortController().signal,
        model: activeModel,
        sessionId: "sess_parent",
        toolCallId: "toolu_agent_model",
        traceId: "trace_parent",
        workingDirectory: "/workspace",
        workspaceRoot: "/workspace",
        subagentPort: {
          async launch(_request: unknown, options: Record<string, unknown> | undefined) {
            launchOptions.push(options);
            return {
              status: "completed",
              agentId: "agent_model",
              agentType: "general-purpose",
              prompt: "inherit the parent model",
              content: [{ type: "text", text: "done" }],
              totalDurationMs: 1,
              totalToolUseCount: 0,
            };
          },
        },
      } as any,
    );

    expect(launchOptions).toEqual([expect.objectContaining({ model: activeModel })]);
  });

  it("formats local-agent task notifications with the provider-visible XML shape", () => {
    const notification = formatTaskNotification({
      agentId: "agent_done",
      description: "review diff",
      outputFile: "/tmp/agent_done/output.txt",
      result: "Done <ok>",
      status: "completed",
      subagentType: "code-reviewer",
      summary: 'Agent code-reviewer task "review diff" completed.',
      taskId: "agent_done",
      taskType: "local_agent",
      toolUseId: "toolu_123",
      usage: {
        durationMs: 33,
        modelUsage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 11,
        },
        toolUseCount: 2,
        totalTokens: 11,
      },
    });

    expect(notification.split("\n")[0]).toBe("<task-notification>");
    expect(notification).toContain("<task-id>agent_done</task-id>");
    expect(notification).toContain("<tool-use-id>toolu_123</tool-use-id>");
    expect(notification).toContain("<output-file>/tmp/agent_done/output.txt</output-file>");
    expect(notification).toContain("<status>completed</status>");
    expect(notification).toContain(
      "<summary>Agent code-reviewer task &quot;review diff&quot; completed.</summary>",
    );
    expect(notification).toContain("<result>Done &lt;ok&gt;</result>");
    expect(notification).toContain(
      "<usage><subagent_tokens>11</subagent_tokens><tool_uses>2</tool_uses><duration_ms>33</duration_ms></usage>",
    );
    expect(notification).not.toContain("SYSTEM NOTIFICATION");
    expect(notification).not.toContain("<task-type>");
    expect(notification).not.toContain("<agent-id>");
    expect(notification).not.toContain("<subagent-type>");
    expect(notification).not.toContain("<description>");
    expect(notification).not.toContain("<total-tokens>");
    expect(notification).not.toContain("<input-tokens>");
  });

  it("omits local-agent notification token usage when token usage is unavailable", () => {
    const notification = formatTaskNotification({
      agentId: "agent_done",
      description: "review diff",
      outputFile: "/tmp/agent_done/output.txt",
      result: "Done",
      status: "completed",
      subagentType: "code-reviewer",
      summary: 'Agent code-reviewer task "review diff" completed.',
      taskId: "agent_done",
      taskType: "local_agent",
      toolUseId: "toolu_123",
      usage: {
        durationMs: 33,
        modelUsage: {},
        toolUseCount: 2,
      },
    });

    expect(notification).not.toContain("<subagent_tokens>");
    expect(notification).toContain("<tool_uses>2</tool_uses>");
    expect(notification).toContain("<duration_ms>33</duration_ms>");
  });

  it("formats local-bash task notifications with provider-visible XML shape", () => {
    const notification = formatTaskNotification({
      description: "run tests",
      outputFile: "/tmp/bash/stdout.log",
      result: "must not be provider-visible",
      status: "completed",
      error: "must not be provider-visible",
      stderrFile: "/tmp/bash/stderr.log",
      stdoutFile: "/tmp/bash/stdout.log",
      summary: 'Background command "npm test" completed (exit code 0)',
      taskId: "exec_done",
      taskType: "local_bash",
      toolUseId: "toolu_bash",
    });

    expect(notification).toBe(
      [
        "<task-notification>",
        "<task-id>exec_done</task-id>",
        "<tool-use-id>toolu_bash</tool-use-id>",
        "<output-file>/tmp/bash/stdout.log</output-file>",
        "<status>completed</status>",
        '<summary>Background command "npm test" completed (exit code 0)</summary>',
        "</task-notification>",
      ].join("\n"),
    );
  });

  it("keeps local-agent runtime fields out of provider-visible SendMessage output schema", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      includeSendMessage: true,
    });

    const byName = new Map(registry.toContracts().map((tool) => [tool.name, tool]));
    const providerOutputSchema = JSON.stringify(byName.get("SendMessage")?.outputSchema);

    expect(providerOutputSchema).toContain("success");
    expect(providerOutputSchema).toContain("message");
    expect(providerOutputSchema).not.toContain("status");
    expect(providerOutputSchema).not.toContain("messageId");
    expect(providerOutputSchema).not.toContain("delivery");
    expect(providerOutputSchema).not.toContain("agentId");
    expect(providerOutputSchema).not.toContain("taskId");

    expect(
      sendMessageToolEntry.formatModelContent?.({
        status: "success",
        messageId: "msg_1",
        delivery: "queued",
        agentId: "agent_1",
        message: "Message queued for delivery to agent_1 at its next tool round.",
      }),
    ).toBe("Message queued for delivery to agent_1 at its next tool round.");
  });

  it("aligns P0 tool prompt semantic guidance", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      includeAgent: true,
      includeSkill: true,
      includeWorkflow: true,
    });

    const byName = new Map(registry.toContracts().map((tool) => [tool.name, tool]));

    const todoWriteDescription = byName.get("TodoWrite")?.description ?? "";
    expect(todoWriteDescription).toContain("task list for the current session");
    expect(todoWriteDescription).toContain("rendered to the user as your working plan");
    expect(todoWriteDescription).toContain("replaces the previous one");
    expect(todoWriteDescription).toContain("Keep one item");
    expect(todoWriteDescription).toContain("in_progress");
    expect(todoWriteDescription).toContain("completed");
    expect(todoWriteDescription).not.toContain("activeForm");
    expect(todoWriteDescription).not.toContain("## When to Use");
    expect(todoWriteDescription).not.toContain("<reasoning>");

    const enterPlanDescription = byName.get("EnterPlanMode")?.description ?? "";
    expect(enterPlanDescription).toContain("non-trivial implementation task");
    expect(enterPlanDescription).toContain("explore the codebase");
    expect(enterPlanDescription).toContain("using Glob, Grep, and Read");
    expect(enterPlanDescription).not.toContain("`find`/Glob");
    expect(enterPlanDescription).not.toContain("`grep`/Grep");
    expect(enterPlanDescription).toContain("AskUserQuestion");
    expect(enterPlanDescription).toContain("ExitPlanMode");
    expect(enterPlanDescription).toContain("REQUIRES user approval");
    expect(enterPlanDescription).toContain(
      "Pure research/exploration tasks (use the Agent tool instead)",
    );
    expect(enterPlanDescription).not.toContain("with explore agent instead");

    const exitPlanDescription = byName.get("ExitPlanMode")?.description ?? "";
    expect(exitPlanDescription).toContain("plan parameter");
    expect(exitPlanDescription).toContain("complete plan");
    expect(exitPlanDescription).toContain("Do NOT use AskUserQuestion");
    expect(exitPlanDescription).toContain("ExitPlanMode inherently requests user approval");
    expect(exitPlanDescription).not.toContain("read the plan from the file");
    expect(exitPlanDescription).not.toContain("ExitPlanMode V2");

    const askDescription = byName.get("AskUserQuestion")?.description ?? "";
    expect(askDescription).toContain("blocked on a decision");
    expect(askDescription).toContain("cannot resolve from the request");
    expect(askDescription).toContain("sensible defaults");
    expect(askDescription).toContain("Do NOT use this tool to ask");
  });

  it("aligns P1 tool prompt semantic guidance", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      includeAgent: true,
      includeSkill: true,
      includeWorkflow: true,
    });

    const byName = new Map(registry.toContracts().map((tool) => [tool.name, tool]));

    const bashDescription = byName.get("Bash")?.description ?? "";
    expect(bashDescription).toContain("Executes a bash command and returns its output.");
    expect(bashDescription).toContain("Working directory persists between calls");
    expect(bashDescription).toContain("Avoid using this tool to run");
    expect(bashDescription).toContain("run_in_background");
    expect(bashDescription).toContain("# Git");
    expect(bashDescription).not.toContain("Usage:");

    const skillDescription = byName.get("Skill")?.description ?? "";
    const normalizedSkillDescription = skillDescription.toLowerCase();
    expect(skillDescription).toContain("available skills");
    expect(skillDescription).toContain("slash command");
    expect(skillDescription).toContain("exact name");
    expect(skillDescription).toContain("Never guess or invent");
    expect(normalizedSkillDescription).toContain("blocking requirement");
    expect(normalizedSkillDescription).toContain("already been loaded");
    expect(skillDescription).toContain("built-in CLI commands");
  });

  it("keeps provider prompts at the intended guidance depth", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      includeAgent: true,
      includeSkill: true,
      includeWorkflow: true,
    });

    const byName = new Map(registry.toContracts().map((tool) => [tool.name, tool]));
    const wordCount = (text: string) => text.trim().split(/\s+/u).filter(Boolean).length;

    const todoWriteDescription = byName.get("TodoWrite")?.description ?? "";
    expect(todoWriteDescription.length, "SIMPLE todo description should stay compact").toBeLessThan(
      1500,
    );
    expect(todoWriteDescription).toContain("task list for the current session");
    expect(todoWriteDescription).toContain("replaces the previous one");
    expect(todoWriteDescription).toContain("Keep one item");
    expect(todoWriteDescription).not.toContain("<reasoning>");
    expect(todoWriteDescription).not.toContain("## When to Use");
    expect(todoWriteDescription).not.toContain("activeForm");

    const askDescription = byName.get("AskUserQuestion")?.description ?? "";
    expect(askDescription.length).toBeGreaterThan(1700);
    expect(askDescription).toContain("Preview feature");
    expect(askDescription).toContain("rendered as markdown in a monospace box");
    expect(askDescription).toContain("side-by-side layout");
    expect(askDescription).toContain("single-select");
    expect(askDescription).toContain("Do not use previews for simple preference questions");

    const askSchema = byName.get("AskUserQuestion")?.inputSchema as any;
    const previewDescription =
      askSchema?.properties?.questions?.items?.properties?.options?.items?.properties?.preview
        ?.description ?? "";
    expect(previewDescription).toBe(
      "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
    );

    const bashDescription = byName.get("Bash")?.description ?? "";
    expect(bashDescription.length).toBeLessThan(1600);
    expect(wordCount(bashDescription)).toBeGreaterThan(120);
    expect(bashDescription).toContain("Executes a bash command and returns its output.");
    expect(bashDescription).toContain("Working directory persists between calls");
    expect(bashDescription).toContain("Avoid using this tool to run");
    expect(bashDescription).toContain("`find`, `grep`, `cat`");
    expect(bashDescription).toContain("default 120000, max 600000");
    expect(bashDescription).toContain("run_in_background");
    expect(bashDescription).toContain("# Git");
    expect(bashDescription).not.toContain("Usage:");
    expect(bashDescription).not.toContain("DO NOT use newlines to separate commands");
    expect(bashDescription).not.toContain("Always create NEW commits rather than amending");

    const explorePrompt = buildExploreSystemPrompt({
      workingDirectory: "/workspace/project",
      workspaceRoot: "/workspace/project",
      envInfo: {
        isGitRepository: true,
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 24.3.0",
      },
      modelName: "Haiku 4.5",
    });
    expect(explorePrompt).toContain("Use Glob for broad file pattern matching");
    expect(explorePrompt).toContain("Use Grep for searching file contents with regex");
    expect(explorePrompt).not.toContain("Use WebSearch");
    expect(explorePrompt).not.toContain("exact model ID");
    expect(explorePrompt).not.toContain("Assistant knowledge cutoff");
  });

  it("keeps built-in tool JSON schemas provider-compatible", () => {
    for (const entry of builtInTools) {
      const schemaIssues = [
        ...findProviderSchemaIssues(entry.inputSchema, `${entry.metadata.name}.inputSchema`),
        ...findProviderSchemaIssues(entry.outputSchema, `${entry.metadata.name}.outputSchema`),
      ];

      expect(schemaIssues, entry.metadata.name).toEqual([]);
    }
  });

  it("only exposes Agent when a subagent port is configured", () => {
    const defaultRegistry = createToolRegistry();
    registerBuiltInTools(defaultRegistry);

    const agentRegistry = createToolRegistry();
    registerBuiltInTools(agentRegistry, { includeAgent: true });

    expect(defaultRegistry.has("Agent")).toBe(false);
    expect(defaultRegistry.has("Task")).toBe(false);
    expect(agentRegistry.has("Agent")).toBe(true);
    expect(agentRegistry.has("Task")).toBe(true);
    expect(agentRegistry.toContracts().map((tool) => tool.name)).toContain("Agent");
    expect(agentRegistry.toContracts().map((tool) => tool.name)).not.toContain("Task");
    expect(agentRegistry.get("Task")?.handler).toBe(agentRegistry.get("Agent")?.handler);
    expect(agentRegistry.get("Task")?.inputSchema).toBe(agentRegistry.get("Agent")?.inputSchema);
    expect(agentRegistry.get("Task")?.permission?.permission).toBe("subagent");
    expect(agentRegistry.get("Agent")?.metadata.concurrentSafe).toBe(true);
    expect(agentRegistry.get("Task")?.metadata.concurrentSafe).toBe(true);
    expect(agentRegistry.get("Agent")?.metadata.timeoutMs).toBeUndefined();
    expect(agentRegistry.get("Task")?.metadata.timeoutMs).toBeUndefined();
    expect(agentRegistry.get("Agent")?.timeout).toEqual({ kind: "none" });
    expect(agentRegistry.get("Task")?.timeout).toEqual({ kind: "none" });
    expect(agentRegistry.get("Agent")?.metadata.description).toContain(
      "`run_in_background: true` runs the agent asynchronously",
    );
    expect(agentRegistry.get("Agent")?.metadata.description).not.toContain("currently runs inline");
  });

  it("only exposes SendMessage when subagent messaging is configured", () => {
    const defaultRegistry = createToolRegistry();
    registerBuiltInTools(defaultRegistry);

    const subagentRegistry = createToolRegistry();
    registerBuiltInTools(subagentRegistry, { includeSendMessage: true });

    expect(defaultRegistry.has("SendMessage")).toBe(false);
    expect(subagentRegistry.has("SendMessage")).toBe(true);
  });

  it("only exposes RespondToCoordinator with its child control capability", () => {
    const defaultRegistry = createToolRegistry();
    registerBuiltInTools(defaultRegistry);

    const childRegistry = createToolRegistry();
    registerBuiltInTools(childRegistry, { includeRespondToCoordinator: true });

    const disallowedRegistry = createToolRegistry();
    registerBuiltInTools(disallowedRegistry, {
      disallowedTools: ["RespondToCoordinator"],
      includeRespondToCoordinator: true,
    });

    expect(defaultRegistry.has("RespondToCoordinator")).toBe(false);
    expect(disallowedRegistry.has("RespondToCoordinator")).toBe(false);

    const entry = childRegistry.get("RespondToCoordinator");
    expect(entry?.metadata).toMatchObject({
      allowedInPlanMode: true,
      concurrentSafe: true,
      needsApproval: false,
      readOnly: false,
      sideEffectScope: "session",
    });
    expect(Object.keys(entry?.inputSchema.properties ?? {})).toEqual(["summary", "message"]);
    expect(Object.keys(entry?.outputSchema.properties ?? {})).toEqual(["success", "message"]);

    const description = childRegistry
      .toContracts()
      .find((tool) => tool.name === "RespondToCoordinator")?.description;
    expect(description).toContain("Message from coordinator:");
    expect(description).toContain("do not use assistant text as the reply");
    expect(description).toContain("Continue the current task");
    expect(
      defaultRegistry
        .toContracts()
        .map((tool) => tool.description)
        .join("\n"),
    ).not.toContain("RespondToCoordinator");
  });

  it("exposes Glob and Grep in the direct search branch", () => {
    const mainRegistry = createToolRegistry();
    registerBuiltInTools(mainRegistry, { includeAgent: true });

    const mainAllowlistRegistry = createToolRegistry();
    registerBuiltInTools(mainAllowlistRegistry, { allowedTools: ["Read", "Glob", "Grep"] });

    const exploreRegistry = createToolRegistry();
    registerBuiltInTools(exploreRegistry, {
      allowedTools: ["Read", "Glob", "Grep"],
    });

    expect(mainRegistry.has("Agent")).toBe(true);
    expect(mainRegistry.has("Glob")).toBe(true);
    expect(mainRegistry.has("Grep")).toBe(true);
    expect(mainAllowlistRegistry.list()).toEqual(["Read", "Glob", "Grep"]);
    expect(exploreRegistry.list()).toEqual(["Read", "Glob", "Grep"]);
  });

  it("does not expose explicitly disallowed built-in tools", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      includeAgent: true,
      disallowedTools: ["TodoWrite", "Bash"],
    });

    expect(registry.has("Read")).toBe(true);
    expect(registry.has("TodoWrite")).toBe(false);
    expect(registry.has("Bash")).toBe(false);
    expect(registry.toContracts().map((tool) => tool.name)).not.toContain("TodoWrite");
  });

  it("uses the embedded search provider-visible branch when enabled", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      embeddedSearchEnabled: true,
      includeAgent: true,
    });

    const byName = new Map(registry.toContracts().map((contract) => [contract.name, contract]));

    expect(byName.has("Glob")).toBe(false);
    expect(byName.has("Grep")).toBe(false);

    const bashDescription = byName.get("Bash")?.description ?? "";
    expect(bashDescription).toBe(
      [
        "Executes a bash command and returns its output.",
        "",
        "- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
        "- IMPORTANT: Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.",
        "- `timeout` is in milliseconds: default 120000, max 600000.",
        "- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
        "",
        "# Git",
        "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
        "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
        "- Commit or push only when the user asks. If on the default branch, branch first.",
      ].join("\n"),
    );
    expect(bashDescription).toContain(
      "Avoid using this tool to run `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands",
    );
    expect(bashDescription).not.toContain("`find`, `grep`");

    const agentDescription = byName.get("Agent")?.description ?? "";
    expect(agentDescription).not.toContain("Tools: Glob, Grep");
    expect(agentDescription).toContain("Available agent types are listed in <system-reminder> messages in the conversation.");
    expect(agentDescription).not.toContain("(Tools:");
    expect(agentDescription).not.toContain("<system-reminder>\n");

    const enterPlanDescription = byName.get("EnterPlanMode")?.description ?? "";
    expect(enterPlanDescription).toContain("using `find`/Glob, `grep`/Grep, and Read");
    expect(enterPlanDescription).not.toContain("using `find`, `grep`, and Read");
    expect(enterPlanDescription).not.toContain("using Glob, Grep, and Read");

    const explorePrompt = buildExploreSystemPrompt({
      workingDirectory: "/workspace/project",
      workspaceRoot: "/workspace/project",
      embeddedSearchEnabled: true,
      envInfo: {
        isGitRepository: true,
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 24.3.0",
      },
      modelName: "fast-search-model",
    });
    expect(explorePrompt).toContain("Use `find` via Bash for broad file pattern matching");
    expect(explorePrompt).toContain("Use `grep` via Bash for searching file contents with regex");
    expect(explorePrompt).toContain(
      "Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, grep, cat, head, tail)",
    );
    expect(explorePrompt).not.toContain("Use Glob for broad file pattern matching");
    expect(explorePrompt).not.toContain("Use Grep for searching file contents with regex");
  });

  it("keeps the supported Agent and Bash provider-visible input schema descriptions", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeAgent: true });

    const byName = new Map(registry.toContracts().map((contract) => [contract.name, contract]));
    const agentInput = byName.get("Agent")?.inputSchema as any;
    const bashInput = byName.get("Bash")?.inputSchema as any;

    expect(agentInput.properties.description.description).toBe(
      "A short (3-5 word) description of the task",
    );
    expect(agentInput.properties.prompt.description).toBe("The task for the agent to perform");
    expect(agentInput.properties.subagent_type.description).toBe(
      "The type of specialized agent to use for this task",
    );
    expect(agentInput.properties.run_in_background.description).toBe(
      "Set to true to run this agent in the background. You will be notified when it completes.",
    );
    expect(agentInput.properties.subagent_type.enum).toBeUndefined();
    expect(agentInput.properties).not.toHaveProperty("model");

    expect(bashInput.properties.command.description).toBe("The command to execute");
    expect(bashInput.properties.timeout.description).toBe(
      "Optional timeout in milliseconds (max 600000)",
    );
    expect(bashInput.properties.description.description).toBe(
      [
        'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.',
        "",
        "For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):",
        '- ls → "List files in current directory"',
        '- git status → "Show working tree status"',
        '- npm install → "Install package dependencies"',
        "",
        "For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:",
        '- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"',
        '- git reset --hard origin/main → "Discard all local changes and match remote main"',
        "- curl -s url | jq '.data[]' → \"Fetch JSON from URL and extract data array elements\"",
      ].join("\n"),
    );
    expect(bashInput.properties.run_in_background.description).toBe(
      "Set to true to run this command in the background.",
    );
    expect(bashInput.properties.dangerouslyDisableSandbox.description).toBe(
      "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
    );
  });

  it("drops the legacy Agent model field at the runtime input boundary", () => {
    const parsed = AgentInputSchema.parse({
      description: "Inspect runtime",
      model: "haiku",
      prompt: "Find the model selection path.",
      subagent_type: "Explore",
    });

    // 修复原因：历史会话可能诱导模型继续生成旧字段；字段可以留在 transcript，
    // 但进入本次工具执行时必须被丢弃，不能覆盖当前 Agent profile。
    expect(parsed).toEqual({
      description: "Inspect runtime",
      prompt: "Find the model selection path.",
      subagent_type: "Explore",
    });
  });

  it("aligns provider-visible hard schema diffs for P-12", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, {
      includeAgent: true,
    });

    const contracts = registry.toContracts();
    const byName = new Map(contracts.map((contract) => [contract.name, contract]));
    const skillInput = byName.get("Skill")?.inputSchema as any;
    const readInput = byName.get("Read")?.inputSchema as any;
    const writeInput = byName.get("Write")?.inputSchema as any;
    const editInput = byName.get("Edit")?.inputSchema as any;
    const todoWrite = byName.get("TodoWrite");
    const todoWriteInput = todoWrite?.inputSchema as any;
    const exitPlanInput = byName.get("ExitPlanMode")?.inputSchema as any;

    expect(skillInput.properties).toHaveProperty("skill");
    expect(skillInput.properties).not.toHaveProperty("name");
    expect(skillInput.required).toEqual(expect.arrayContaining(["skill"]));
    expect(skillInput.properties.skill.description).toBe(
      "The name of a skill from the available-skills list. Do not guess names.",
    );
    expect(skillInput.properties.args.description).toBe("Optional arguments for the skill");

    expect(readInput.properties.file_path.description).toContain("absolute");
    expect(readInput.properties.file_path.description).not.toMatch(/relative|session cwd/iu);
    expect(readInput.properties.offset.description).toBe(
      "The line number to start reading from. Only provide if the file is too large to read at once",
    );
    expect(readInput.properties.limit.description).toBe(
      "The number of lines to read. Only provide if the file is too large to read at once.",
    );
    expect(readInput.properties).not.toHaveProperty("pages");
    expect(writeInput.properties.file_path.description).toBe(
      "The absolute path to the file to write (must be absolute, not relative)",
    );
    expect(writeInput.properties.content.description).toBe("The content to write to the file");
    expect(editInput.properties.file_path.description).toContain("absolute");
    expect(editInput.properties.file_path.description).not.toMatch(/relative|session cwd/iu);
    const webFetchInput = byName.get("WebFetch")?.inputSchema as any;
    expect(webFetchInput.properties.url.description).toBe("The URL to fetch content from");
    expect(webFetchInput.properties.prompt.description).toBe(
      "The prompt to run on the fetched content",
    );
    const webSearchInput = byName.get("WebSearch")?.inputSchema as any;
    expect(webSearchInput.properties.query.description).toBe("The search query to use");
    expect(webSearchInput.properties.allowed_domains.description).toBe(
      "Only include search results from these domains",
    );
    expect(webSearchInput.properties.blocked_domains.description).toBe(
      "Never include search results from these domains",
    );
    expect(webSearchInput.properties).not.toHaveProperty("maxUses");
    expect(exitPlanInput.properties.allowedPrompts.description).toBe(
      "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
    );
    expect(exitPlanInput.properties.allowedPrompts.items.properties.tool.description).toBe(
      "The tool this prompt applies to",
    );
    expect(exitPlanInput.properties.allowedPrompts.items.properties.prompt.description).toBe(
      'Semantic description of the action, e.g. "run tests", "install dependencies"',
    );

    const todoItem = todoWriteInput.properties.todos.items;
    expect(todoItem.properties).toHaveProperty("content");
    expect(todoItem.properties).toHaveProperty("status");
    expect(todoItem.properties).toHaveProperty("priority");
    expect(todoItem.properties).not.toHaveProperty("activeForm");
    expect(todoItem.properties.status.enum).toEqual(["pending", "in_progress", "completed"]);
    expect(todoWrite?.description).toContain("task list for the current session");
    expect(todoWrite?.description).toContain("replaces the previous one");
    expect(todoWrite?.description).toContain("Keep one item");
  });

  it("describes Grep input with ripgrep-oriented guidance", () => {
    const properties = grepToolEntry.inputSchema.properties as Record<
      string,
      { description?: string }
    >;

    expect(properties.pattern?.description).toBe(
      "The regular expression pattern to search for in file contents",
    );
    expect(properties.glob?.description).toBe(
      'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
    );
    expect(properties["-o"]?.description).toBe(
      'Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: "content", ignored otherwise. Defaults to false.',
    );
    expect(properties.multiline?.description).toContain("rg -U --multiline-dotall");
  });

  it("describes Glob and Grep provider contracts without session-cwd wording", () => {
    const globSchema = globToolEntry.inputSchema as any;
    const grepSchema = grepToolEntry.inputSchema as any;

    expect(globSchema.required).toEqual(["pattern"]);
    expect(grepSchema.required).toEqual(["pattern"]);
    expect(globSchema.additionalProperties).toBe(false);
    expect(grepSchema.additionalProperties).toBe(false);

    expect(globSchema.properties.path.description).toContain("current working directory");
    expect(grepSchema.properties.path.description).toContain("current working directory");
    expect(globSchema.properties.path.description).not.toMatch(/session cwd/iu);
    expect(grepSchema.properties.path.description).not.toMatch(/session cwd/iu);

    expect(globToolEntry.metadata.description).toContain("modification time");
    expect(globToolEntry.metadata.description).toContain("glob patterns");
    expect(grepToolEntry.metadata.description).toContain("files_with_matches");
    expect(grepToolEntry.metadata.description).toContain("Content search built on ripgrep.");
  });

  it("formats Glob results as provider-visible file lists for the model", () => {
    expect(
      globToolEntry.formatModelContent?.({
        durationMs: 1,
        numFiles: 2,
        filenames: ["src/a.ts", "src/b.ts"],
        truncated: false,
      }),
    ).toBe("src/a.ts\nsrc/b.ts");

    expect(
      globToolEntry.formatModelContent?.({
        durationMs: 1,
        numFiles: 0,
        filenames: [],
        truncated: false,
      }),
    ).toBe("No files found");

    expect(
      globToolEntry.formatModelContent?.({
        durationMs: 1,
        numFiles: 2,
        filenames: ["src/a.ts", "src/b.ts"],
        truncated: true,
      }),
    ).toBe(
      "src/a.ts\nsrc/b.ts\n(Results are truncated. Consider using a more specific path or pattern.)",
    );
  });

  it("uses the provider-visible Read prompt for supported capabilities", () => {
    expect(readToolEntry.metadata.description).toBe(SOURCE_DERIVED_READ_SHORT_DESCRIPTION);
    expect(readToolEntry.metadata.description).toContain("cat -n format");
    expect(readToolEntry.metadata.description).toContain("Reads images (PNG, JPG, …)");
    expect(readToolEntry.metadata.description).toContain("Do NOT re-read a file you just edited");
    expect(readToolEntry.metadata.description).not.toContain("PDF");
    expect(readToolEntry.metadata.description).not.toContain("Jupyter");
    expect(readToolEntry.metadata.description).not.toContain("pages");
    expect(readToolEntry.metadata.modelInstructions).toBeUndefined();
  });

  it("keeps Bash model input simple while accepting semantic runtime values", () => {
    const properties = bashToolEntry.inputSchema.properties as Record<string, { type?: string }>;

    expect(properties).toHaveProperty("command");
    expect(properties).toHaveProperty("timeout");
    expect(properties).toHaveProperty("description");
    expect(properties).toHaveProperty("run_in_background");
    expect(properties).toHaveProperty("dangerouslyDisableSandbox");
    expect(properties).not.toHaveProperty("argv");
    expect(properties).not.toHaveProperty("cwd");
    expect(properties).not.toHaveProperty("env");
    expect(properties.timeout?.type).toBe("number");
    expect(properties.run_in_background?.type).toBe("boolean");
    expect(properties.dangerouslyDisableSandbox?.type).toBe("boolean");

    expect(
      bashToolEntry.runtimeInputSchema.parse({
        command: "npm test",
        timeout: "30000",
        run_in_background: "true",
        dangerouslyDisableSandbox: "0",
      }),
    ).toEqual({
      command: "npm test",
      timeout: 30000,
      run_in_background: true,
      dangerouslyDisableSandbox: false,
    });

    expect(() =>
      bashToolEntry.runtimeInputSchema.parse({
        command: "node -v",
        argv: { file: "node", args: ["-v"] },
      }),
    ).toThrow();
  });

  it("formats Grep results as search text for the model", () => {
    expect(
      grepToolEntry.formatModelContent?.({
        mode: "files_with_matches",
        durationMs: 1,
        numFiles: 2,
        filenames: ["src/a.ts", "src/b.ts"],
        truncated: false,
      }),
    ).toBe("Found 2 files\nsrc/a.ts\nsrc/b.ts");

    expect(
      grepToolEntry.formatModelContent?.({
        mode: "content",
        durationMs: 1,
        numFiles: 1,
        filenames: [],
        content: "src/a.ts:1:needle",
        numLines: 1,
        numMatches: 1,
        truncated: false,
      }),
    ).toBe("src/a.ts:1:needle");

    expect(
      grepToolEntry.formatModelContent?.({
        mode: "count",
        durationMs: 1,
        numFiles: 1,
        filenames: [],
        content: "src/a.ts:3",
        numMatches: 3,
        truncated: false,
      }),
    ).toBe("src/a.ts:3\n\nFound 3 total occurrences across 1 file.");
  });

  it("caps Grep model-visible results at the search tool budget", () => {
    expect(grepToolEntry.resultBudget?.maxInlineBytes).toBe(20_000);
    expect(grepToolEntry.resultBudget?.maxModelBytes).toBe(20_000);
    expect(grepToolEntry.resultBudget?.preview?.maxBytes).toBe(20_000);
    expect(grepToolEntry.metadata.maxOutputBytes).toBe(20_000);
  });

  it("formats file mutation results as concise model-visible confirmations", () => {
    const originalFile = "secret old content";
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-secret old content", "+new content"],
      },
    ];

    const editContent = editToolEntry.formatModelContent?.({
      filePath: "/work/file.ts",
      oldString: "old",
      newString: "new",
      originalFile,
      structuredPatch,
      userModified: false,
      replaceAll: true,
    });
    expect(editContent).toBe(
      "The file /work/file.ts has been updated. All occurrences were successfully replaced. (file state is current in your context — no need to Read it back)",
    );
    expect(editContent).not.toContain(originalFile);
    expect(editContent).not.toContain("structuredPatch");

    const writeCreateContent = writeToolEntry.formatModelContent?.({
      type: "create",
      filePath: "/work/new.ts",
      content: "large new file content",
      structuredPatch: [],
      originalFile: null,
    });
    expect(writeCreateContent).toBe(
      "File created successfully at: /work/new.ts (file state is current in your context \u2014 no need to Read it back)",
    );
    expect(writeCreateContent).not.toContain("large new file content");

    const writeUpdateContent = writeToolEntry.formatModelContent?.({
      type: "update",
      filePath: "/work/file.ts",
      content: "large new file content",
      structuredPatch,
      originalFile,
    });
    expect(writeUpdateContent).toBe(
      "The file /work/file.ts has been updated successfully. (file state is current in your context \u2014 no need to Read it back)",
    );
    expect(writeUpdateContent).not.toContain(originalFile);
    expect(writeUpdateContent).not.toContain("large new file content");
  });

  it("formats Read text output as cat-n content without JSON escaping tabs", () => {
    const content = "工作任务\n- [ ] prd auto research 的\n\t- [ ] beta 部分继续";

    const modelContent = readToolEntry.formatModelContent?.({
      type: "text",
      filePath: "/work/2026-05-08.md",
      content,
      numLines: 3,
      startLine: 1,
      totalLines: 3,
    });

    expect(modelContent).toBe(
      "1\t工作任务\n2\t- [ ] prd auto research 的\n3\t\t- [ ] beta 部分继续",
    );
    expect(modelContent).not.toContain("\\t- [ ] beta");
    expect(modelContent).not.toContain('"content"');
  });

  it("exports the Read line-number formatter for raw text content", () => {
    expect(addReadLineNumbers({ content: "alpha\n\tbeta", startLine: 12 })).toBe(
      "12\talpha\n13\t\tbeta",
    );
  });
});

function findProviderSchemaIssues(schema: Record<string, unknown>, path: string): string[] {
  const issues: string[] = [];
  scanProviderSchema(schema, path, issues);
  return issues;
}

function scanProviderSchema(value: unknown, path: string, issues: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanProviderSchema(item, `${path}[${index}]`, issues));
    return;
  }

  if (!isRecord(value)) return;

  for (const key of ["$id", "$ref", "$defs", "definitions", "anyOf"]) {
    if (key in value) {
      issues.push(`${path} contains provider-internal key ${key}`);
    }
  }

  if (("enum" in value || "const" in value) && !("type" in value)) {
    issues.push(`${path} uses enum/const without an explicit type`);
  }

  const typeValues = Array.isArray(value.type) ? value.type : [value.type];
  if (
    typeValues.includes("object") &&
    !isRecord(value.properties) &&
    value.additionalProperties === undefined &&
    value.propertyNames === undefined
  ) {
    issues.push(`${path} is an object schema without properties`);
  }

  if (isRecord(value.properties)) {
    for (const [key, child] of Object.entries(value.properties)) {
      scanProviderSchema(child, `${path}.properties.${key}`, issues);
    }
  }
  scanProviderSchema(value.items, `${path}.items`, issues);
  scanProviderSchema(value.additionalProperties, `${path}.additionalProperties`, issues);
  scanProviderSchema(value.oneOf, `${path}.oneOf`, issues);
  scanProviderSchema(value.allOf, `${path}.allOf`, issues);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
