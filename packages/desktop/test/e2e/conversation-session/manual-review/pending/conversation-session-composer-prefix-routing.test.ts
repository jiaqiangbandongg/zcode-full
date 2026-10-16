import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_V4_COMPOSER_INPUT,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import { DEFAULT_WORKSPACE } from "../../../helpers/desktop-app.js";
import {
  prepareConversationE2E,
  startNewTask,
} from "../../../helpers/conversation-session.js";

const TEST_TIMEOUT_MS = 120000;
const TID_PROMPT_SUGGESTION_PANEL = "prompt-suggestion-panel";
const TID_PROMPT_SUGGESTION_OPTION = "prompt-suggestion-option";
const TID_PROMPT_SUGGESTION_STATUS = "prompt-suggestion-status";
const createdWorkspacePaths: string[] = [];

interface PanelOptionSnapshot {
  id: string | null;
  index: number;
  sectionId: string | null;
  selected: boolean;
  text: string;
}

interface PanelSnapshot {
  options: PanelOptionSnapshot[];
  statuses: Array<{ sectionId: string | null; status: string | null; text: string }>;
  trigger: string | null;
}

describe("会话区 Composer 前缀提示路由 E2E", () => {
  before(async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await prepareConversationE2E();
  });

  beforeEach(async function () {
    this.timeout(TEST_TIMEOUT_MS);

    await startNewTask();
  });

  after(async () => {
    await Promise.all(
      createdWorkspacePaths.map((targetPath) =>
        rm(targetPath, { recursive: true, force: true }),
      ),
    );
    await browser.electron.restoreAllMocks();
    // 修复原因：task index sqlite 由 host/service 生命周期持有，Windows 上在
    // spec-level after 里删除整个 appData 会撞到仍打开的 -shm 文件。全局 e2e
    // beforeSession 会重置隔离 HOME，Electron 退出后的兜底清理由 wdio 生命周期处理。
  });

  it("@ 聚合 plugin/file/session/whiteboard，/ 提示 command/skill/subagent，$ 兼容面板保留，且键盘选择写入正确 mention", async function () {
    this.timeout(TEST_TIMEOUT_MS);

    const runId = Date.now();
    const seed = {
      commandName: `e2e-cmd-${runId}`,
      directoryName: `e2e-route-dir-${runId}`,
      fileName: `e2e-route-file-${runId}.ts`,
      skillName: `e2e-skill-${runId}`,
      subagentName: `e2e-agent-${runId}`,
      whiteboardName: `e2e-route-board-${runId}`,
    };

    await seedWorkspaceFileCandidates(seed);
    await seedRendererPromptSources(seed);

    await setComposerText(`@${seed.fileName}`);
    const atFilePanel = await waitForPanelSections("@", ["files"], "@ 文件候选面板没有打开");
    expect(optionTexts(atFilePanel).join("\n")).toContain(seed.fileName);
    assertPanelExcludesSections(atFilePanel, ["commands", "subagents", "skills"]);
    await browser.keys("Enter");
    await waitForComposerMarkdownContaining(
      seed.fileName,
      "@ 文件候选 Enter 后没有写入文件 mention markdown",
    );

    await setComposerText(`@${seed.directoryName}`);
    const atDirectoryPanel = await waitForPanelSections("@", ["files"], "@ 文件夹候选面板没有打开");
    expect(optionTexts(atDirectoryPanel).join("\n")).toContain(seed.directoryName);
    await browser.keys("Tab");
    await waitForComposerMarkdownContaining(
      `${seed.directoryName}/`,
      "@ 文件夹候选 Tab 后没有写入目录 mention markdown",
    );

    await setComposerText(`@${seed.whiteboardName}`);
    const atWhiteboardPanel = await waitForPanelSections("@", ["whiteboards"], "@ 画板候选面板没有打开");
    expect(optionTexts(atWhiteboardPanel).join("\n")).toContain(seed.whiteboardName);
    assertPanelExcludesSections(atWhiteboardPanel, ["commands", "subagents", "skills"]);

    // S01 语义：`@` 固定按 plugins → files → sessions → whiteboards 路由；
    // 当前 query 只命中 Plugin，选中后仍写入既有 canonical plugin:// markdown。
    // 默认启用的官方纯内容插件 skill-creator 作为确定性候选；选中写入 canonical plugin:// markdown。
    await setComposerText("@skill-creator");
    const atPluginPanel = await waitForPanelSections("@", ["plugins"], "@ plugin 候选面板没有打开");
    expect(optionTexts(atPluginPanel).join("\n")).toContain("skill-creator");
    assertPanelExcludesSections(atPluginPanel, ["commands", "subagents", "skills"]);
    await browser.keys("Enter");
    await waitForComposerMarkdownContaining(
      "plugin://skill-creator@zcode-plugins-official",
      "@ plugin 候选 Enter 后没有写入 canonical plugin mention markdown",
    );

    await setComposerText("/");
    const slashPanel = await waitForPanelSections("/", ["commands", "skills", "subagents"], "/ 候选面板没有打开");
    assertPanelExcludesSections(slashPanel, ["files", "whiteboards"]);

    await setComposerText(`/${seed.commandName}`);
    const slashCommandPanel = await waitForPanelSections("/", ["commands"], "/ command 候选面板没有打开");
    expect(optionTexts(slashCommandPanel).join("\n")).toContain(`/${seed.commandName}`);
    await browser.keys("Enter");
    await waitForComposerMarkdown(
      `/${seed.commandName}`,
      "/ command 候选 Enter 后没有写入 slash command mention markdown",
    );

    await setComposerText(`/${seed.skillName}`);
    const slashSkillPanel = await waitForPanelSections("/", ["skills"], "/ skill 候选面板没有打开");
    expect(optionTexts(slashSkillPanel).join("\n")).toContain(`$${seed.skillName}`);
    await browser.keys("Enter");
    await waitForComposerMarkdownContaining(
      `$${seed.skillName}`,
      "/ skill 候选 Enter 后没有写入 skill mention markdown",
    );

    await setComposerText(`/${seed.subagentName}`);
    const slashSubagentPanel = await waitForPanelSections("/", ["subagents"], "/ subagent 候选面板没有打开");
    expect(optionTexts(slashSubagentPanel).join("\n")).toContain(seed.subagentName);
    await browser.keys("Tab");
    await waitForComposerMarkdown(
      `@${seed.subagentName}`,
      "/ subagent 候选 Tab 后没有写入 subagent mention markdown",
    );

    await setComposerText(`$${seed.skillName}`);
    const skillPanel = await waitForPanelSections("$", ["skills"], "$ skill 候选面板没有打开");
    expect(optionTexts(skillPanel).join("\n")).toContain(seed.skillName);
    assertPanelExcludesSections(skillPanel, ["files", "whiteboards", "commands", "subagents"]);
    await browser.keys("Enter");
    await waitForComposerMarkdownContaining(
      `$${seed.skillName}`,
      "$ skill 候选 Enter 后没有写入 skill mention markdown",
    );
  });
});

async function seedWorkspaceFileCandidates(seed: {
  directoryName: string;
  fileName: string;
}) {
  const directoryPath = join(DEFAULT_WORKSPACE, seed.directoryName);
  const filePath = join(DEFAULT_WORKSPACE, seed.fileName);
  await mkdir(directoryPath, { recursive: true });
  await writeFile(
    filePath,
    "export const e2eComposerPrefixRouting = true;\n",
    "utf-8",
  );
  createdWorkspacePaths.push(directoryPath, filePath);
}

async function seedRendererPromptSources(seed: {
  commandName: string;
  skillName: string;
  subagentName: string;
  whiteboardName: string;
}) {
  const result = (await browser.execute(
    (workspacePath, provider, currentSeed) => {
      const e2eWindow = window as unknown as {
        __skillStoreE2E?: { setState: (state: Record<string, unknown>) => void };
        __subagentsStoreE2E?: { setState: (state: Record<string, unknown>) => void };
        __whiteboardStoreE2E?: {
          getState: () => {
            createBoard: (params: {
              defaultNamePrefix: string;
              workspacePath: string;
            }) => { id: string };
            renameBoard: (params: {
              boardId: string;
              name: string;
              workspacePath: string;
            }) => void;
          };
        };
        __zcodeSessionStoreE2E?: {
          getState: () => {
            setSlashCommands: (
              workspacePath: string,
              commands: Array<{
                description: string;
                inputHint: string;
                name: string;
                source: "custom";
              }>,
            ) => void;
          };
        };
      };
      const sessionStore = e2eWindow.__zcodeSessionStoreE2E;
      const skillStore = e2eWindow.__skillStoreE2E;
      const subagentsStore = e2eWindow.__subagentsStoreE2E;
      const whiteboardStore = e2eWindow.__whiteboardStoreE2E;
      if (!sessionStore || !skillStore || !subagentsStore || !whiteboardStore) {
        return {
          ok: false,
          reason: "missing-e2e-store-bridge",
          bridges: {
            session: Boolean(sessionStore),
            skill: Boolean(skillStore),
            subagents: Boolean(subagentsStore),
            whiteboard: Boolean(whiteboardStore),
          },
        };
      }

      sessionStore.getState().setSlashCommands(workspacePath, [
        {
          name: currentSeed.commandName,
          description: "E2E custom slash command for composer prefix routing",
          inputHint: `/${currentSeed.commandName} <topic>`,
          source: "custom",
        },
      ]);

      skillStore.setState({
        workspacePath,
        workspaceIdentity: null,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: null,
        provider,
        loadedProvider: provider,
        loading: false,
        error: null,
        capability: { userScopeAvailable: true },
        skills: [
          {
            id: `glm:${currentSeed.skillName}`,
            name: currentSeed.skillName,
            description: "E2E skill for composer prefix routing",
            body: "Use this skill only for E2E prefix routing.",
            path: `${workspacePath}/.zcode/skills/${currentSeed.skillName}/SKILL.md`,
            scope: "workspace",
            enabled: true,
          },
        ],
      });

      subagentsStore.setState({
        workspacePath,
        workspaceIdentity: null,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: null,
        provider,
        loadedProvider: provider,
        loading: false,
        error: null,
        capability: { userScopeAvailable: true },
        agents: [
          {
            id: `e2e-${currentSeed.subagentName}`,
            name: currentSeed.subagentName,
            description: "E2E subagent for composer prefix routing",
            systemPrompt: "You are only used by an E2E composer suggestion case.",
            path: `${workspacePath}/.zcode/agents/${currentSeed.subagentName}.md`,
            scope: "workspace",
            source: "user",
            enabled: true,
          },
        ],
      });

      const board = whiteboardStore.getState().createBoard({
        workspacePath,
        defaultNamePrefix: "E2E route board",
      });
      whiteboardStore.getState().renameBoard({
        workspacePath,
        boardId: board.id,
        name: currentSeed.whiteboardName,
      });

      return { ok: true, boardId: board.id };
    },
    DEFAULT_WORKSPACE,
    ZCODE_AGENT_PROVIDER,
    seed,
  )) as { ok: boolean; reason?: string; bridges?: Record<string, boolean> };

  if (!result.ok) {
    throw new Error(`composer prefix routing seed failed: ${JSON.stringify(result)}`);
  }
}

async function setComposerText(text: string) {
  await browser.waitUntil(
    async () =>
      browser.execute((inputTestId, nextText) => {
        const input = document.querySelector<HTMLElement>(
          `[data-testid="${inputTestId}"]`,
        ) as (HTMLElement & {
          __zcodeLexicalInputE2E?: {
            focus: () => void;
            setText: (value: string) => void;
          };
        }) | null;
        const bridge = input?.__zcodeLexicalInputE2E;
        if (!bridge) {
          return false;
        }
        bridge.setText(nextText);
        bridge.focus();
        return true;
      }, TID_V4_COMPOSER_INPUT, text),
    {
      timeout: 10000,
      timeoutMsg: `composer prefix routing: 输入框 E2E bridge 未就绪，无法输入 ${text}`,
    },
  );
}

async function waitForPanelSections(
  trigger: string,
  expectedSectionIds: string[],
  timeoutMsg: string,
) {
  let latest: PanelSnapshot | null = null;
  await browser.waitUntil(
    async () => {
      latest = await getPanelSnapshot();
      // 修复原因：CI runner 上 Lexical 文本更新和 suggestion 过滤会跨帧完成。
      // 只等待 trigger/options 会读到上一帧的全量面板，导致 query-specific 断言误判。
      return (
        latest.trigger === trigger &&
        latest.options.length > 0 &&
        arraysEqual(optionSectionIds(latest), expectedSectionIds)
      );
    },
    {
      timeout: 15000,
      timeoutMsg,
    },
  );
  return latest ?? getPanelSnapshot();
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getPanelSnapshot(): Promise<PanelSnapshot> {
  return browser.execute(
    (panelTestId, optionPrefix, statusPrefix) => {
      const panel = document.querySelector<HTMLElement>(
        `[data-testid="${panelTestId}"]`,
      );
      const options = Array.from(
        panel?.querySelectorAll<HTMLElement>(`[data-testid^="${optionPrefix}-"]`) ?? [],
      ).map((element) => ({
        id: element.getAttribute("data-option-id"),
        index: Number(element.getAttribute("data-option-index") ?? "0"),
        sectionId: element.getAttribute("data-section-id"),
        selected: element.getAttribute("data-selected") === "true",
        text: (element.innerText || element.textContent || "").replace(/\u00a0/g, " ").trim(),
      }));
      const statuses = Array.from(
        panel?.querySelectorAll<HTMLElement>(`[data-testid^="${statusPrefix}-"]`) ?? [],
      ).map((element) => ({
        sectionId: element.getAttribute("data-section-id"),
        status: element.getAttribute("data-status"),
        text: (element.innerText || element.textContent || "").replace(/\u00a0/g, " ").trim(),
      }));
      return {
        options,
        statuses,
        trigger: panel?.getAttribute("data-trigger") ?? null,
      };
    },
    TID_PROMPT_SUGGESTION_PANEL,
    TID_PROMPT_SUGGESTION_OPTION,
    TID_PROMPT_SUGGESTION_STATUS,
  );
}

function optionSectionIds(snapshot: PanelSnapshot) {
  return [
    ...new Set(
      snapshot.options
        .map((item) => item.sectionId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function optionTexts(snapshot: PanelSnapshot) {
  return snapshot.options.map((option) => option.text);
}

function assertPanelExcludesSections(snapshot: PanelSnapshot, excludedSectionIds: string[]) {
  const actualSectionIds = optionSectionIds(snapshot);
  for (const excluded of excludedSectionIds) {
    expect(actualSectionIds).not.toContain(excluded);
  }
}

async function waitForComposerMarkdown(expected: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await getComposerMarkdown()).trim() === expected, {
    timeout: 10000,
    timeoutMsg,
  });
}

async function waitForComposerMarkdownContaining(expected: string, timeoutMsg: string) {
  await browser.waitUntil(async () => (await getComposerMarkdown()).includes(expected), {
    timeout: 10000,
    timeoutMsg,
  });
}

function getComposerMarkdown(): Promise<string> {
  return browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLElement>(
      `[data-testid="${inputTestId}"]`,
    ) as (HTMLElement & {
      __zcodeLexicalInputE2E?: { getText: () => string };
    }) | null;
    return input?.__zcodeLexicalInputE2E?.getText() ?? "";
  }, TID_V4_COMPOSER_INPUT);
}
