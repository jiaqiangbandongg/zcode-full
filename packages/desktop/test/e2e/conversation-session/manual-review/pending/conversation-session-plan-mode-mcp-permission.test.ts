import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { clearAppData, DEFAULT_WORKSPACE } from "../../../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  prepareConversationE2E,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequest,
  waitForToolCallBlockByToolName,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";

const PROMPT_MARKER = "E2E_PLAN_MODE_MCP_PERMISSION";
const LOOKUP_QUERY = "E2E_PLAN_MCP_LOOKUP_QUERY";
const LOOKUP_RESULT = `E2E_PLAN_MCP_LOOKUP_RESULT:${LOOKUP_QUERY}`;
const DESTRUCTIVE_MARKER = "E2E_PLAN_MCP_DESTRUCTIVE_ATTEMPT";
const RESET_RESULT = "E2E_PLAN_MCP_RESET_SHOULD_NOT_RUN";
const DENIAL_TEXT = "Plan mode only allows read-only, non-destructive tools";
const ENTER_TOOL_CALL_ID = "toolu_e2e_plan_mcp_enter_plan";
const LOOKUP_TOOL_CALL_ID = "toolu_e2e_plan_mcp_lookup";
const RESET_TOOL_CALL_ID = "toolu_e2e_plan_mcp_reset";
const LOOKUP_TOOL_NAME = "mcp__plan_mode_e2e__lookup";
const RESET_TOOL_NAME = "mcp__plan_mode_e2e__reset";
const CASE_ROOT = join(DEFAULT_WORKSPACE, "plan-mode-mcp-permission-e2e");
const MCP_CONFIG_DIR = join(DEFAULT_WORKSPACE, ".zcode");
const MCP_CONFIG_FILE = join(MCP_CONFIG_DIR, "config.json");
const MCP_CALL_LOG = join(CASE_ROOT, "mcp-calls.ndjson");
const MCP_SERVER_SCRIPT = resolve(
  process.cwd(),
  "test/e2e/fixtures/mcp/plan-mode-mcp-permission-server.mjs",
);

describe("会话区 Plan mode MCP 权限边界 E2E", () => {
  afterEach(async () => {
    await cleanupPlanModeMcpFixture();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await cleanupPlanModeMcpFixture();
    await clearAppData();
  });

  it("Y01/Y02: Plan mode 允许非 destructive MCP，但拒绝 destructive MCP", async function () {
    this.timeout(180000);

    await prepareConversationE2E();
    await writePlanModeMcpConfig();

    const prompt = [
      `${PROMPT_MARKER}: Enter plan mode first.`,
      `Then call ${LOOKUP_TOOL_NAME} with query ${LOOKUP_QUERY}.`,
      `After lookup, call ${RESET_TOOL_NAME} with marker ${DESTRUCTIVE_MARKER}.`,
      `Do not call ExitPlanMode. Finish only after the MCP boundary is handled.`,
    ].join(" ");

    await sendPrompt(prompt);
    await waitForComposerText("", "Plan mode MCP 首发后输入框没有清空");
    await waitForUserMessageContaining(PROMPT_MARKER);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, LOOKUP_TOOL_NAME, RESET_TOOL_NAME],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "首轮请求没有暴露 Plan mode MCP E2E 工具 schema",
      60000,
    );

    await waitForToolCallBlockByToolName("EnterPlanMode", 60000);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, ENTER_TOOL_CALL_ID],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "EnterPlanMode 结果没有进入 lookup 前的 provider continuation",
      60000,
    );

    await waitForToolCallBlockByToolName(LOOKUP_TOOL_NAME, 90000);
    await waitForMcpCall("lookup", 60000);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, LOOKUP_TOOL_CALL_ID, LOOKUP_RESULT],
        excludes: [
          DENIAL_TEXT,
          "Generate a concise title",
          "CRITICAL: Respond with TEXT ONLY",
        ],
      },
      "非 destructive MCP lookup 没有真实执行并进入 provider continuation",
      60000,
    );

    await waitForToolCallBlockByToolName(RESET_TOOL_NAME, 60000);
    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, RESET_TOOL_CALL_ID, DENIAL_TEXT],
        excludes: [
          RESET_RESULT,
          "Generate a concise title",
          "CRITICAL: Respond with TEXT ONLY",
        ],
      },
      "destructive MCP reset 没有在调用 server 前被 Plan mode 拒绝",
      60000,
    );
    const resetBlock = await waitForToolCallBlockStatus(
      RESET_TOOL_NAME,
      "failed",
      60000,
    );
    expect(resetBlock.text).not.toContain("Running");

    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForChatState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "Plan mode MCP 权限边界 case 完成后没有回到 idle",
      60000,
    );

    const calls = await readMcpCalls();
    expect(calls.some((call) => call.tool === "lookup")).toBe(true);
    expect(calls.some((call) => call.tool === "reset")).toBe(false);
  });
});

async function writePlanModeMcpConfig() {
  await mkdir(CASE_ROOT, { recursive: true });
  await mkdir(MCP_CONFIG_DIR, { recursive: true });
  await writeFile(
    MCP_CONFIG_FILE,
    `${JSON.stringify(
      {
        mcp: {
          servers: {
            plan_mode_e2e: {
              type: "stdio",
              command: process.execPath,
              args: [MCP_SERVER_SCRIPT],
              env: {
                E2E_PLAN_MCP_CALL_LOG: MCP_CALL_LOG,
              },
              timeoutMs: 30000,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

async function cleanupPlanModeMcpFixture() {
  await rm(CASE_ROOT, { recursive: true, force: true });
  await rm(MCP_CONFIG_FILE, { force: true });
}

interface McpCallLogEntry {
  tool?: string;
}

async function waitForMcpCall(tool: string, timeoutMs: number) {
  let latest: McpCallLogEntry[] = [];
  await browser.waitUntil(
    async () => {
      latest = await readMcpCalls();
      return latest.some((call) => call.tool === tool);
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `没有等到 MCP server 调用 ${tool}; latest=${JSON.stringify(latest)}`,
    },
  );
}

async function waitForToolCallBlockStatus(
  toolName: string,
  status: string,
  timeoutMs: number,
) {
  let latest = await waitForToolCallBlockByToolName(toolName, timeoutMs);
  await browser.waitUntil(
    async () => {
      latest = await waitForToolCallBlockByToolName(toolName, timeoutMs);
      return latest.status === status;
    },
    {
      timeout: timeoutMs,
      timeoutMsg: `tool block ${toolName} 没有进入 ${status}; latest=${JSON.stringify(latest)}`,
    },
  );
  return latest;
}

async function readMcpCalls(): Promise<McpCallLogEntry[]> {
  try {
    const raw = await readFile(MCP_CALL_LOG, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as McpCallLogEntry);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
