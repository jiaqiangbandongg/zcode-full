import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { botConfigSchema, DEFAULT_BOT_COMMANDS } from "@zcode/shared";
import { BotsRepo } from "../src/bots/repo.js";
import { normalizeBotCurrentOptions } from "../src/bots/config.js";
import { setDataBaseDir } from "../src/paths.js";
import * as f from "./botsService.fixtures.js";

describe("Bot v3 单向导入与回滚文件隔离", () => {
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bot-v3-"));
    setDataBaseDir(root);
    dir = join(root, ".zcode", "v2");
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  });

  const legacyState = (draftOptions: unknown) => ({
    version: 2,
    bots: {
      bot: {
        botId: "bot",
        workspacePath: "/workspace",
        mode: "draft",
        activeTaskId: null,
        draftOptions,
        updatedAt: 1,
      },
    },
  });
  const makeRepo = () => new BotsRepo();

  it("远端旧状态不使用本地账号转换，失联时不主动重连", async () => {
    const raw = legacyState({ provider: "glm", model: "builtin:bigmodel-coding-plan/GLM" });
    await writeFile(
      join(dir, "bot-state.v2.json"),
      JSON.stringify({
        ...raw,
        bots: { bot: { ...raw.bots.bot, workspaceIdentity: "ssh://remote/workspace" } },
      }),
    );
    const getModelSelectionService = vi.fn();
    const service = f.createBotsService({
      credentialService: f.createCredentialService({}),
      modelSelectionService: f.createModelSelectionService([]),
      runStartupBackgroundTasks: false,
      remoteWorkspaceService: {
        isConnected: async () => false,
        ensureConnected: vi.fn(async () => ({ ok: true })),
        getModelSelectionService,
      },
    });
    try {
      const states = await service.getBotStates();
      expect(states[0]?.draftOptions?.modelSelection).toEqual({
        providerId: "account:bigmodel-individual-coding-plan",
        modelId: "GLM",
      });
      expect(states[0]?.workspaceIdentity).toBe("ssh://remote/workspace");
      expect(getModelSelectionService).not.toHaveBeenCalled();
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("Config 导入保留绑定；新增/编辑/删除只写 v3，staging strict Reader 仍读到原配置", async () => {
    // 冻结 6e781fdd9029 的 Options Reader；外围 Bot 字段与当前相同，不建立运行时兼容 Schema。
    const oldOptionsSchema = z
      .object({
        model: z.string().min(1).optional(),
        mode: z.string().min(1).optional(),
        thoughtLevel: z.string().min(1).optional(),
        sandboxMode: z.string().min(1).optional(),
        approvalPolicy: z.string().min(1).optional(),
        cli: z.enum(["codex", "claude", "opencode", "gemini", "glm"]).optional(),
      })
      .strict();
    const oldReader = z
      .object({
        version: z.literal(2),
        bots: z.array(botConfigSchema.extend({ currentOptions: oldOptionsSchema })),
      })
      .strict();
    const bot = {
      id: "bot",
      name: "Original",
      provider: "webhook",
      enabled: false,
      webhookSecretRef: "credential-reference",
      providerUserId: "bound-user",
      allowedWorkspaces: ["*"],
      allowedCommands: DEFAULT_BOT_COMMANDS,
      replyMode: "assistant_changes",
      currentOptions: { model: "deepseek/model", thoughtLevel: "high" },
    };
    const original = {
      version: 2,
      bots: [bot, { ...bot, id: "missing", currentOptions: { model: "missing/model" } }],
    };
    expect(oldReader.safeParse(original).success).toBe(true);
    const bytes = JSON.stringify(original);
    await writeFile(join(dir, "bot-config.json"), bytes);
    const repo = makeRepo();
    const current = await repo.readConfig();
    expect(current.bots).toHaveLength(2);
    expect(current.bots[0]).toMatchObject({
      providerUserId: "bound-user",
      currentOptions: {
        modelSelection: {
          providerId: "deepseek",
          modelId: "model",
          options: { reasoningLevel: "high" },
        },
      },
    });
    expect(current.bots[1]?.currentOptions).toEqual({
      modelSelection: { providerId: "missing", modelId: "model" },
    });
    // 如果仍往旧文件写新 Options，即使保持 version:2，旧 Reader 也会整份拒绝。
    expect(oldReader.safeParse({ ...current, version: 2 }).success).toBe(false);
    await repo.writeConfig({
      ...current,
      bots: [...current.bots, { ...current.bots[0]!, id: "new" }],
    });
    await repo.writeConfig({ version: 3, bots: [{ ...current.bots[0]!, name: "Edited" }] });
    await repo.writeConfig({ version: 3, bots: [] });
    expect((await repo.readConfig()).bots).toEqual([]);
    const retained = await readFile(join(dir, "bot-config.json"), "utf8");
    expect(retained).toBe(bytes);
    expect(oldReader.parse(JSON.parse(retained))).toEqual(original);
  });

  it("并发首次读取只导入一次，并在读成功时固定旧 Coding Plan 身份", async () => {
    await writeFile(
      join(dir, "bot-state.v2.json"),
      JSON.stringify(legacyState({ provider: "glm", model: "builtin:bigmodel-coding-plan/GLM" })),
    );
    const repo = new BotsRepo();
    const results = await Promise.all([repo.readState(), repo.readState()]);
    expect(results[0]).toEqual(results[1]);
    expect((await makeRepo().readState()).bots.bot?.draftOptions?.modelSelection?.providerId).toBe(
      "account:bigmodel-individual-coding-plan",
    );
  });

  it("只补齐缺失的 Config，不覆盖已有 v3 State", async () => {
    await writeFile(join(dir, "bot-state.v3.json"), '{"version":3,"bots":{}}');
    await writeFile(
      join(dir, "bot-state.v2.json"),
      JSON.stringify(legacyState({ provider: "glm", model: "deepseek/model" })),
    );
    await writeFile(join(dir, "bot-config.json"), '{"version":2,"bots":[]}');
    await makeRepo().readConfig();
    expect(await makeRepo().readState()).toEqual({ version: 3, bots: {} });
  });

  it("首次导入并立即固定 v3，之后写入不改旧文件，也不再导入已删除的状态", async () => {
    const old = JSON.stringify(
      legacyState({ provider: "glm", model: "deepseek/model", thoughtLevel: "high" }),
    );
    await writeFile(join(dir, "bot-state.v2.json"), old);
    await writeFile(join(dir, "bot-config.json"), '{"version":2,"bots":[]}');
    const repo = makeRepo();
    const state = await repo.readState();
    expect(state.version).toBe(3);
    expect(state.bots.bot?.draftOptions?.modelSelection).toEqual({
      providerId: "deepseek",
      modelId: "model",
      options: { reasoningLevel: "high" },
    });
    expect(JSON.parse(await readFile(join(dir, "bot-state.v3.json"), "utf8"))).toEqual(state);
    expect(await repo.readConfig()).toEqual({ version: 3, bots: [] });
    await repo.writeState({ version: 3, bots: {} });
    expect(await makeRepo().readState()).toEqual({ version: 3, bots: {} });
    expect(await readFile(join(dir, "bot-state.v2.json"), "utf8")).toBe(old);
    expect(await readFile(join(dir, "bot-config.json"), "utf8")).toBe('{"version":2,"bots":[]}');
  });

  it("当前 v3 损坏时不回读旧文件，也不覆盖损坏文件", async () => {
    await writeFile(
      join(dir, "bot-state.v2.json"),
      JSON.stringify(legacyState({ provider: "glm", model: "deepseek/model" })),
    );
    await writeFile(join(dir, "bot-state.v3.json"), "broken");
    await expect(makeRepo().readState()).rejects.toThrow();
    expect(await readFile(join(dir, "bot-state.v3.json"), "utf8")).toBe("broken");
  });

  it("无旧数据时只创建 v3；部分 v3 已存在时不重新导入该文件", async () => {
    const repo = makeRepo();
    expect(await repo.readConfig()).toEqual({ version: 3, bots: [] });
    expect(await repo.readState()).toEqual({ version: 3, bots: {} });
    await expect(access(join(dir, "bot-config.json"))).rejects.toThrow();
    await expect(access(join(dir, "bot-state.v2.json"))).rejects.toThrow();
  });

  it("未知 Provider 仍保留原意图，不按同名模型换供应商、不丢掉 Bot 状态", async () => {
    await writeFile(
      join(dir, "bot-state.v2.json"),
      JSON.stringify(legacyState({ provider: "glm", model: "missing/model", mode: "yolo" })),
    );
    expect((await makeRepo().readState()).bots.bot).toMatchObject({
      botId: "bot",
      workspacePath: "/workspace",
      draftOptions: { mode: "yolo" },
    });
    expect((await makeRepo().readState()).bots.bot?.draftOptions?.modelSelection).toEqual({
      providerId: "missing",
      modelId: "model",
    });
  });

  it("已有新选择时不读旧 model/thoughtLevel，普通保存也不解释旧字段", async () => {
    const modelSelection = {
      providerId: "deepseek",
      modelId: "model",
      options: { reasoningLevel: "low" },
    };
    await writeFile(
      join(dir, "bot-state.v2.json"),
      JSON.stringify(legacyState({ provider: "glm", modelSelection, thoughtLevel: "high" })),
    );
    expect((await makeRepo().readState()).bots.bot?.draftOptions?.modelSelection).toEqual(
      modelSelection,
    );
    expect(normalizeBotCurrentOptions({ model: "deepseek/model", thoughtLevel: "high" })).toEqual(
      {},
    );
  });
});
