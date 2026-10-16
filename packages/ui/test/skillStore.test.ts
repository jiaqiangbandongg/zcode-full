import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ISkillsService } from "@zcode/services";
import { useSkillStore } from "../src/store/skillStore.js";

function createSkillsServiceMock(overrides?: {
  list?: ISkillsService["list"];
  setEnabled?: ISkillsService["setEnabled"];
}): ISkillsService {
  return {
    list:
      overrides?.list ??
      vi.fn(async () => ({
        skills: [],
        capability: { userScopeAvailable: true },
        diagnostics: [],
      })),
    setEnabled: overrides?.setEnabled ?? vi.fn(async () => {}),
    buildPromptContext: vi.fn(async ({ prompt }) => ({
      prompt,
      activatedSkillNames: [],
    })),
  };
}

describe("skillStore", () => {
  beforeEach(() => {
    useSkillStore.setState({
      workspacePath: null,
      loadedWorkspacePath: null,
      skills: [],
      capability: null,
      loading: false,
      error: null,
    });
  });

  it("initialize 在空技能列表时也会记录 loadedWorkspacePath", async () => {
    const service = createSkillsServiceMock();
    const workspacePath = "/tmp/workspace-empty-skills";

    await useSkillStore.getState().initialize(workspacePath, service);
    const state = useSkillStore.getState();

    expect(state.workspacePath).toBe(workspacePath);
    expect(state.loadedWorkspacePath).toBe(workspacePath);
    expect(state.skills).toEqual([]);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("initialize 失败时也会设置 loadedWorkspacePath，避免重复初始化", async () => {
    const service = createSkillsServiceMock({
      list: vi.fn(async () => {
        throw new Error("load skills failed");
      }),
    });
    const workspacePath = "/tmp/workspace-load-fail";

    await useSkillStore.getState().initialize(workspacePath, service);
    const state = useSkillStore.getState();

    expect(state.workspacePath).toBe(workspacePath);
    expect(state.loadedWorkspacePath).toBe(workspacePath);
    expect(state.loading).toBe(false);
    expect(state.error).toBe("load skills failed");
  });

  it("setEnabled 会调用服务并触发 refresh 更新列表", async () => {
    const list = vi
      .fn<ISkillsService["list"]>()
      .mockResolvedValueOnce({
        skills: [
          {
            id: "skill-1",
            name: "code-review",
            description: "review",
            body: "body",
            path: "/tmp/skill.md",
            scope: "workspace",
            enabled: true,
          },
        ],
        capability: { userScopeAvailable: true },
      })
      .mockResolvedValueOnce({
        skills: [
          {
            id: "skill-1",
            name: "code-review",
            description: "review",
            body: "body",
            path: "/tmp/skill.md",
            scope: "workspace",
            enabled: false,
          },
        ],
        capability: { userScopeAvailable: true },
      });
    const setEnabled = vi.fn(async () => {});
    const service = createSkillsServiceMock({ list, setEnabled });
    const workspacePath = "/tmp/workspace-set-enabled";

    await useSkillStore.getState().initialize(workspacePath, service);
    await useSkillStore.getState().setEnabled("skill-1", false, service);

    expect(setEnabled).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity: undefined,
      provider: "glm",
      skillId: "skill-1",
      enabled: false,
    });
    expect(useSkillStore.getState().skills[0]?.enabled).toBe(false);
  });

  it("并发 initialize 同一工作区时会复用同一个 list 请求", async () => {
    let resolveList: ((value: Awaited<ReturnType<ISkillsService["list"]>>) => void) | null = null;
    const list = vi.fn<ISkillsService["list"]>(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    const service = createSkillsServiceMock({ list });
    const workspacePath = "/tmp/workspace-concurrent";

    const first = useSkillStore.getState().initialize(workspacePath, service);
    const second = useSkillStore.getState().initialize(workspacePath, service);

    expect(list).toHaveBeenCalledTimes(1);

    resolveList?.({
      skills: [
        {
          id: "skill-1",
          name: "code-review",
          description: "review",
          body: "body",
          path: "/tmp/skill.md",
          scope: "workspace",
          enabled: true,
        },
      ],
      capability: { userScopeAvailable: true },
    });

    await Promise.all([first, second]);

    expect(useSkillStore.getState().skills[0]?.name).toBe("code-review");
  });

  it("切换 legacy provider 时会归一到 ZCode Agent 并清理上一套缓存", async () => {
    let resolveList: ((value: Awaited<ReturnType<ISkillsService["list"]>>) => void) | null = null;
    const list = vi.fn<ISkillsService["list"]>(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    const service = createSkillsServiceMock({ list });
    const workspacePath = "/tmp/workspace-provider-switch";

    useSkillStore.setState({
      workspacePath,
      loadedWorkspacePath: workspacePath,
      provider: "glm",
      loadedProvider: "claude",
      skills: [
        {
          id: "skill-old",
          name: "a-stock-analysis",
          description: "old",
          body: "old-body",
          path: "/tmp/old-skill.md",
          scope: "workspace",
          enabled: true,
        },
      ],
      capability: { userScopeAvailable: true },
      loading: false,
      error: null,
    });

    const pending = useSkillStore.getState().initialize(workspacePath, "codex", service);

    expect(useSkillStore.getState().skills).toEqual([]);
    expect(useSkillStore.getState().capability).toBeNull();
    expect(useSkillStore.getState().loading).toBe(true);

    resolveList?.({
      skills: [
        {
          id: "skill-new",
          name: "code-review",
          description: "new",
          body: "new-body",
          path: "/tmp/new-skill.md",
          scope: "workspace",
          enabled: true,
        },
      ],
      capability: { userScopeAvailable: true },
    });

    await pending;

    expect(useSkillStore.getState().loadedProvider).toBe("glm");
    expect(useSkillStore.getState().skills.map((skill) => skill.name)).toEqual(["code-review"]);
  });

});
