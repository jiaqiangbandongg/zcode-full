import { afterEach, describe, expect, it, vi } from "vitest";
import type { ISkillsService } from "@zcode/services";
import {
  ZCODE_AGENT_PROVIDER,
  type SkillSummary,
  type SkillsListResult,
} from "@zcode/shared";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { useSkillStore } from "@/store/skillStore.js";

function createSkill(name: string): SkillSummary {
  return {
    id: `user:${name}`,
    name,
    description: `${name} description`,
    body: "",
    path: `/root/.zcode/skills/${name}/SKILL.md`,
    scope: "user",
    enabled: true,
  };
}

function createSkillsService(result: SkillsListResult): ISkillsService {
  return {
    list: vi.fn(async () => result),
    setEnabled: vi.fn(async () => undefined),
    buildPromptContext: vi.fn(async () => ({
      prompt: "",
      activatedSkillNames: [],
    })),
    copyToCommon: vi.fn(async () => ({ newPath: "" })),
    removeFromCommon: vi.fn(async () => undefined),
    deleteSkill: vi.fn(async () => undefined),
  };
}

function setLoadedSkillStore(params: {
  workspacePath: string;
  workspaceIdentity: string | null;
  skills?: SkillSummary[];
}): void {
  useSkillStore.setState({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    loadedWorkspacePath: params.workspacePath,
    loadedWorkspaceIdentity: params.workspaceIdentity,
    provider: ZCODE_AGENT_PROVIDER,
    loadedProvider: ZCODE_AGENT_PROVIDER,
    skills: params.skills ?? [createSkill("old-skill")],
    capability: { userScopeAvailable: true },
    loading: false,
    error: null,
  });
}

describe("refreshSharedSkillStoreForWorkspace", () => {
  afterEach(() => {
    useSkillStore.setState({
      workspacePath: null,
      workspaceIdentity: null,
      loadedWorkspacePath: null,
      loadedWorkspaceIdentity: null,
      provider: ZCODE_AGENT_PROVIDER,
      loadedProvider: null,
      skills: [],
      capability: null,
      loading: false,
      error: null,
    });
  });

  it("refreshes the shared skill cache for the loaded remote workspace identity", async () => {
    const workspacePath = "/root/project";
    const workspaceIdentity = "ssh://root@localhost:2223/root/project";
    const newSkill = createSkill("synced-skill");
    const skillsService = createSkillsService({
      skills: [newSkill],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    });

    setLoadedSkillStore({
      workspacePath,
      workspaceIdentity,
    });

    await refreshSharedSkillStoreForWorkspace({
      workspacePath,
      workspaceIdentity: ` ${workspaceIdentity} `,
      skillsService,
    });

    expect(skillsService.list).toHaveBeenCalledWith({
      workspacePath,
      workspaceIdentity,
      provider: ZCODE_AGENT_PROVIDER,
    });
    expect(useSkillStore.getState().skills).toEqual([newSkill]);
  });

  it("does not refresh when the loaded workspace identity belongs to another remote", async () => {
    const workspacePath = "/root/project";
    const oldSkill = createSkill("old-skill");
    const skillsService = createSkillsService({
      skills: [createSkill("other-remote-skill")],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    });

    setLoadedSkillStore({
      workspacePath,
      workspaceIdentity: "ssh://root@host-a/root/project",
      skills: [oldSkill],
    });

    await refreshSharedSkillStoreForWorkspace({
      workspacePath,
      workspaceIdentity: "ssh://root@host-b/root/project",
      skillsService,
    });

    expect(skillsService.list).not.toHaveBeenCalled();
    expect(useSkillStore.getState().skills).toEqual([oldSkill]);
  });
});
