import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useZCodeSessionStore } from "../src/store/zcodeSessionStore.js";
import { LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY } from "../src/lib/zcodeProviderPreference.js";

function createStorageMock(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));

  return {
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

describe("agent provider preference", () => {
  beforeEach(() => {
    useZCodeSessionStore.setState((state) => ({
      ...state,
      workspaces: {},
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("新 workspace 会把旧 provider 偏好归一为 glm", () => {
    const storage = createStorageMock({
      [LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY]: "gemini",
    });
    vi.stubGlobal("window", { localStorage: storage });

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState("/tmp/workspace-gemini");

    expect(workspaceState.selectedProvider).toBe("glm");
  });

  it("最近一次选择是 glm 时也能返回完整的默认 workspace 状态", () => {
    const storage = createStorageMock({
      [LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY]: "glm",
    });
    vi.stubGlobal("window", { localStorage: storage });

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState("/tmp/workspace-glm");

    expect(workspaceState.selectedProvider).toBe("glm");
    expect(workspaceState.taskListVersion).toBe(0);
    expect(workspaceState.workspaceInit.status).toBe("idle");
  });

  it("startDraft 选择旧 provider 时也会立即归一最近一次选择", () => {
    const storage = createStorageMock();
    vi.stubGlobal("window", { localStorage: storage });

    useZCodeSessionStore.getState().startDraft("/tmp/workspace-draft", "gemini");

    expect(storage.getItem(LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY)).toBe("glm");
    expect(useZCodeSessionStore.getState().getWorkspaceState("/tmp/workspace-draft").selectedProvider).toBe(
      "glm",
    );
  });
});
