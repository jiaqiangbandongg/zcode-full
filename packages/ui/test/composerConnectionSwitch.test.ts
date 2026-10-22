// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEffectiveModelSelection, type ProviderRegistryView } from "@zcode/provider";
import type { ComposerConnection } from "@/lib/composerPlanGroups.js";
import { useComposerConnectionSwitch } from "@/hooks/useComposerConnectionSwitch.js";
import { persistProviderFamilyConnection } from "@/lib/providerFamilyConnectionTransition.js";
import type { AppSettings } from "@zcode/shared";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
const mocks = vi.hoisted(() => {
  const settings = { providerFamilyConnectionSelections: {} } as Record<string, unknown>;
  const base = {
    settingService: { get: vi.fn(async () => settings) },
    providerSettingsService: { refresh: vi.fn(async () => {}) },
    modelSelectionService: { getView: vi.fn(), onDidChange: vi.fn(() => ({ dispose: vi.fn() })) },
  };
  return {
    base,
    target: base,
    settings,
    update: vi.fn(async (patch: unknown) => {
      Object.assign(settings, patch);
    }),
  };
});
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.base,
  useWorkspaceServicesResolution: () => ({ services: mocks.target, rpcReady: true }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({ useSettings: () => ({ update: mocks.update }) }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: () => "Switch failed; select again to retry" } }),
}));
const providerId = "account:bigmodel-team-coding-plan";
const connection: ComposerConnection = {
  key: "team1",
  label: "Team One",
  family: "bigmodel",
  providerId,
  selection: { kind: "team-coding-plan", productId: "p", organizationId: "o", projectId: "j" },
  items: [],
};
const view = {
  revision: 2,
  providers: [
    {
      providerId,
      config: {
        access: { type: "zhipu-account", accountType: "bigmodel", mode: "team-coding-plan" },
        api: { type: "anthropic-messages" },
      },
      models: [{ modelId: "GLM-5.3", config: { optionSpecs: { reasoningLevel: { values: [] } } } }],
    },
  ],
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.target = mocks.base;
  mocks.settings.providerFamilyConnectionSelections = {
    bigmodel: { kind: "individual-coding-plan" },
  };
  mocks.base.modelSelectionService.getView.mockResolvedValue(view);
  mocks.base.providerSettingsService.refresh.mockResolvedValue(undefined);
});
afterEach(cleanup);
describe("Composer connection switching ownership", () => {
  it("同步完成才选择目标模型，快速重复点击只提交一次", async () => {
    const wait = deferred<void>();
    mocks.base.providerSettingsService.refresh.mockReturnValueOnce(wait.promise);
    const onSelectModel = vi.fn();
    const { result } = renderHook(() =>
      useComposerConnectionSwitch({
        workspacePath: "/work",
        agentProvider: "glm",
        normalizedValue: "",
        onSelectModel,
      }),
    );
    let task!: Promise<void>;
    await act(async () => {
      task = result.current.select(connection);
      await Promise.resolve();
    });
    expect(result.current.pending).toBe(true);
    expect(onSelectModel).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.select(connection);
    });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await act(async () => {
      wait.resolve();
      await task;
    });
    expect(onSelectModel).toHaveBeenCalledWith(encodeCustomModelValue(providerId, "GLM-5.3"));
    expect(result.current.pending).toBe(false);
  });
  it("普通 API 进入团队时携带刚同步目录的思考档位，不能依赖旧 API 目录", async () => {
    mocks.base.modelSelectionService.getView.mockResolvedValue({
      ...view,
      providers: [
        {
          ...view.providers[0],
          models: [
            {
              modelId: "GLM-5.3",
              config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } },
            },
          ],
        },
      ],
    });
    const onSelectModel = vi.fn();
    const { result } = renderHook(() =>
      useComposerConnectionSwitch({
        workspacePath: "/work",
        agentProvider: "glm",
        normalizedValue: encodeCustomModelValue("ordinary-api", "GLM-5.3"),
        onSelectModel,
      }),
    );
    await act(async () => {
      await result.current.select(connection);
    });
    expect(onSelectModel).toHaveBeenCalledWith(
      encodeCustomModelValue(providerId, "GLM-5.3"),
      "max",
    );
  });
  it.each(["account:bigmodel-individual-coding-plan", providerId])(
    "同一账号族的同名模型只切连接，不重新选模清空 reasoning：%s",
    async (sourceProvider) => {
      const onSelectModel = vi.fn();
      const { result } = renderHook(() =>
        useComposerConnectionSwitch({
          workspacePath: "/work",
          agentProvider: "glm",
          normalizedValue: encodeCustomModelValue(sourceProvider, "GLM-5.3"),
          onSelectModel,
        }),
      );
      await act(async () => {
        await result.current.select(connection);
      });
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(onSelectModel).not.toHaveBeenCalled();
      expect(result.current.error).toBeNull();
    },
  );
  it.each([
    ["individual-coding-plan", "team-coding-plan"],
    ["team-coding-plan", "individual-coding-plan"],
  ] as const)("同名账号模型等待有效选择呈现后结束 loading，并可切回：%s → %s", async (from, to) => {
    const id = (kind: string) => `account:bigmodel-${kind}`;
    const original = {
      providerId: id(from),
      modelId: "GLM-5.3",
      options: { reasoningLevel: "high" },
    };
    const catalog = {
      ...view,
      providers: [from, to].map((kind) => ({
        ...view.providers[0],
        providerId: id(kind),
        config: {
          ...view.providers[0]!.config,
          access: {
            type: "zhipu-account",
            accountType: "bigmodel",
            mode: kind,
          },
        },
        models: [
          {
            modelId: "GLM-5.3",
            config: {
              optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } },
            },
          },
        ],
      })),
    };
    mocks.settings.providerFamilyConnectionSelections = { bigmodel: { kind: from } };
    mocks.base.modelSelectionService.getView.mockResolvedValue(catalog);
    const onSelectModel = vi.fn();
    const { result } = renderHook(() => {
      const current = (
        mocks.settings.providerFamilyConnectionSelections as {
          bigmodel: { kind: string };
        }
      ).bigmodel.kind;
      // 对齐生产草稿 owner：保留原意图，展示与提交消费 Host 解析的有效选择。
      const selection = resolveEffectiveModelSelection({
        selection: original,
        registry: catalog as unknown as ProviderRegistryView,
        classifyProvider: () => "account-plan",
        accountStates: {
          [id(current)]: { availability: "available", entitled: true, current: true },
        },
      }).effectiveSelection!;
      const switching = useComposerConnectionSwitch({
        workspacePath: "/work",
        agentProvider: "glm",
        normalizedValue: encodeCustomModelValue(selection.providerId, selection.modelId),
        waitForPresentation: true,
        presentationStatus: "ready",
        onSelectModel,
      });
      return { ...switching, selection };
    });
    for (const kind of [to, from]) {
      await act(async () => {
        await result.current.select({
          ...connection,
          providerId: id(kind),
          key: kind,
          selection:
            kind === "individual-coding-plan" ? { kind } : { ...connection.selection!, kind },
        });
      });
      expect(result.current.pending).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.selection).toEqual({ ...original, providerId: id(kind) });
      expect(onSelectModel).not.toHaveBeenCalled();
    }
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(original.providerId).toBe(id(from));
  });
  it("不同 workspaceIdentity 即使路径相同也拒绝旧结果", async () => {
    const wait = deferred<typeof view>();
    mocks.base.modelSelectionService.getView.mockReturnValueOnce(wait.promise);
    const onSelectModel = vi.fn();
    const { result, rerender } = renderHook(
      ({ identity }) =>
        useComposerConnectionSwitch({
          workspacePath: "/work",
          workspaceIdentity: identity,
          agentProvider: "glm",
          normalizedValue: "",
          onSelectModel,
        }),
      { initialProps: { identity: "ssh:first" } },
    );
    let task!: Promise<void>;
    await act(async () => {
      task = result.current.select(connection);
      await Promise.resolve();
    });
    rerender({ identity: "ssh:second" });
    await act(async () => {
      wait.resolve(view);
      await task;
    });
    expect(onSelectModel).not.toHaveBeenCalled();
  });
  it("同步失败恢复原身份并允许重试", async () => {
    mocks.base.providerSettingsService.refresh.mockRejectedValueOnce(new Error("offline"));
    const onSelectModel = vi.fn();
    const { result } = renderHook(() =>
      useComposerConnectionSwitch({
        workspacePath: "/work",
        agentProvider: "glm",
        normalizedValue: "",
        onSelectModel,
      }),
    );
    await act(async () => {
      await result.current.select(connection);
    });
    expect(result.current.error).toContain("retry");
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(mocks.settings.providerFamilyConnectionSelections).toEqual({
      bigmodel: { kind: "individual-coding-plan" },
    });
    await act(async () => {
      await result.current.select(connection);
    });
    expect(onSelectModel).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });
  it("远端目录仍是旧团队身份时拒绝提交，即使同名模型存在", async () => {
    mocks.base.providerSettingsService.refresh.mockResolvedValue({
      providers: [{ providerId, accountState: { connectionKey: "new-team" } }],
    } as never);
    mocks.target = {
      ...mocks.base,
      providerSettingsService: {
        refresh: vi.fn().mockResolvedValue({
          providers: [{ providerId, accountState: { connectionKey: "old-team" } }],
        }),
      },
      modelSelectionService: { getView: vi.fn().mockResolvedValue(view) },
    };
    const onSelectModel = vi.fn();
    const { result } = renderHook(() =>
      useComposerConnectionSwitch({
        workspacePath: "/work",
        workspaceIdentity: "ssh:host",
        agentProvider: "glm",
        normalizedValue: "",
        onSelectModel,
      }),
    );
    await act(async () => {
      await result.current.select(connection);
    });
    expect(onSelectModel).not.toHaveBeenCalled();
    expect(result.current.error).toContain("retry");
    expect(mocks.settings.providerFamilyConnectionSelections).toEqual({
      bigmodel: { kind: "individual-coding-plan" },
    });
  });

  it("连接读取完成后仍 loading，直到界面确认目标选择", async () => {
    const onSelectModel = vi.fn();
    const { result, rerender } = renderHook(
      ({ value, status }) =>
        useComposerConnectionSwitch({
          workspacePath: "/work",
          agentProvider: "glm",
          normalizedValue: value,
          waitForPresentation: true,
          presentationStatus: status as "loading" | "ready",
          onSelectModel,
        }),
      { initialProps: { value: encodeCustomModelValue("api", "model"), status: "loading" } },
    );
    await act(async () => {
      await result.current.select(connection, "previous");
    });
    expect(result.current.pending).toBe(true);
    rerender({ value: encodeCustomModelValue(providerId, "GLM-5.3"), status: "ready" });
    expect(result.current.pending).toBe(false);
  });
  it("展示读取失败会解除等待并显示可重试错误", async () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: "loading" | "error" }) =>
        useComposerConnectionSwitch({
          workspacePath: "/work",
          agentProvider: "glm",
          normalizedValue: "",
          waitForPresentation: true,
          presentationStatus: status,
          onSelectModel: vi.fn(),
        }),
      { initialProps: { status: "loading" } },
    );
    await act(async () => {
      await result.current.select(connection);
    });
    expect(result.current.pending).toBe(true);
    rerender({ status: "error" });
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeTruthy();
  });
  it("API 选择不写套餐设置", async () => {
    const onSelectModel = vi.fn();
    const { result } = renderHook(() =>
      useComposerConnectionSwitch({
        workspacePath: "/work",
        agentProvider: "glm",
        normalizedValue: "",
        onSelectModel,
      }),
    );
    await act(async () => {
      await result.current.select({ ...connection, selection: undefined });
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(onSelectModel).toHaveBeenCalledTimes(1);
  });
});

describe("Connection rollback ownership", () => {
  it.each(["zai", "bigmodel"] as const)(
    "另一窗口更新品牌版本 %s 后，旧请求失败不能覆盖新意图",
    async (nextFamily) => {
      let settings: Partial<AppSettings> = {
        providerFamilyDomain: "bigmodel",
        providerFamilyDomainUpdatedAt: 1,
        providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
      };
      const update = vi.fn(async (patch: Partial<AppSettings>) => {
        settings = { ...settings, ...patch };
      });
      const synchronize = vi.fn(async () => {
        settings = {
          ...settings,
          providerFamilyDomain: nextFamily,
          providerFamilyDomainUpdatedAt: (settings.providerFamilyDomainUpdatedAt ?? 0) + 1,
          providerFamilyConnectionSelections: {
            ...settings.providerFamilyConnectionSelections,
            zai: { kind: "individual-coding-plan" },
          },
        };
        throw new Error("synchronization failed");
      });
      await expect(
        persistProviderFamilyConnection({
          family: "bigmodel",
          selection: connection.selection!,
          read: async () => structuredClone(settings),
          update,
          synchronize,
        }),
      ).rejects.toThrow("synchronization failed");
      expect(settings.providerFamilyDomain).toBe(nextFamily);
      expect(settings.providerFamilyConnectionSelections?.zai).toEqual({
        kind: "individual-coding-plan",
      });
      expect(update).toHaveBeenCalledTimes(1);
      expect(synchronize).toHaveBeenCalledTimes(1);
    },
  );
});

describe("CAS connection admission", () => {
  it("两个 deferred 请求同读后写：后写冲突，不抹掉先写的 family", async () => {
    let settings: Partial<AppSettings> = {
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: {},
    };
    const reads = [deferred<Partial<AppSettings>>(), deferred<Partial<AppSettings>>()];
    let readCount = 0;
    const update = vi.fn(async (patch: Partial<AppSettings>, expected?: Partial<AppSettings>) => {
      if (
        !expected ||
        expected.providerFamilyDomain !== settings.providerFamilyDomain ||
        JSON.stringify(expected.providerFamilyConnectionSelections) !==
          JSON.stringify(settings.providerFamilyConnectionSelections)
      )
        throw new Error("Account connection settings changed");
      settings = { ...settings, ...patch };
    });
    const read = () => reads[readCount++]!.promise;
    const synchronize = vi.fn(async () => undefined);
    const first = persistProviderFamilyConnection({
      family: "bigmodel",
      selection: connection.selection!,
      read,
      update,
      synchronize,
    });
    const second = persistProviderFamilyConnection({
      family: "zai",
      selection: { kind: "individual-coding-plan" },
      read,
      update,
      synchronize,
    });
    const rejected = expect(second).rejects.toThrow("Account connection settings changed");
    const snapshot = structuredClone(settings);
    reads[0]!.resolve(snapshot);
    await first;
    reads[1]!.resolve(snapshot);
    await rejected;
    expect(settings.providerFamilyConnectionSelections).toEqual({ bigmodel: connection.selection });
    expect(synchronize).toHaveBeenCalledTimes(1);
  });

  it("回滚检查后有另一写入：锁内 CAS 不撤销成功设置", async () => {
    let settings: Partial<AppSettings> = {
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: {},
    };
    let writes = 0;
    const update = vi.fn(async (patch: Partial<AppSettings>, expected?: Partial<AppSettings>) => {
      if (++writes === 2)
        settings = {
          ...settings,
          providerFamilyDomain: "zai",
          providerFamilyConnectionSelections: {
            ...settings.providerFamilyConnectionSelections,
            zai: { kind: "individual-coding-plan" },
          },
        };
      if (
        expected &&
        (expected.providerFamilyDomain !== settings.providerFamilyDomain ||
          JSON.stringify(expected.providerFamilyConnectionSelections) !==
            JSON.stringify(settings.providerFamilyConnectionSelections))
      )
        throw new Error("Account connection settings changed");
      settings = { ...settings, ...patch };
    });
    const synchronize = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      persistProviderFamilyConnection({
        family: "bigmodel",
        selection: connection.selection!,
        read: async () => structuredClone(settings),
        update,
        synchronize,
      }),
    ).rejects.toThrow("offline");
    expect(settings.providerFamilyDomain).toBe("zai");
    expect(settings.providerFamilyConnectionSelections?.bigmodel).toEqual(connection.selection);
    expect(settings.providerFamilyConnectionSelections?.zai).toEqual({
      kind: "individual-coding-plan",
    });
    expect(synchronize).toHaveBeenCalledTimes(1);
  });

  it("后一个请求同步失败：只恢复它提交前的设置，保留前一个成功 family", async () => {
    let settings: Partial<AppSettings> = {
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: {},
    };
    const update = async (patch: Partial<AppSettings>, expected?: Partial<AppSettings>) => {
      if (
        expected &&
        JSON.stringify(expected.providerFamilyConnectionSelections) !==
          JSON.stringify(settings.providerFamilyConnectionSelections)
      )
        throw new Error("Account connection settings changed");
      settings = { ...settings, ...patch };
    };
    const read = async () => structuredClone(settings);
    await persistProviderFamilyConnection({
      family: "bigmodel",
      selection: connection.selection!,
      read,
      update,
      synchronize: async () => undefined,
    });
    const synchronize = vi.fn(async (restoring?: boolean) => {
      if (!restoring) throw new Error("offline");
    });
    await expect(
      persistProviderFamilyConnection({
        family: "zai",
        selection: { kind: "individual-coding-plan" },
        read,
        update,
        synchronize,
      }),
    ).rejects.toThrow("offline");
    expect(settings.providerFamilyConnectionSelections?.bigmodel).toEqual(connection.selection);
    expect(settings.providerFamilyConnectionSelections?.zai).toBeUndefined();
    expect(settings.providerFamilyDomain).toBe("bigmodel");
    expect(synchronize).toHaveBeenCalledWith(true);
  });
});

it("ready 不匹配解除 pending，显示错误并允许下一次选择", async () => {
  const { result, rerender } = renderHook(
    ({ status, value }) =>
      useComposerConnectionSwitch({
        workspacePath: "/work",
        agentProvider: "glm",
        normalizedValue: value,
        waitForPresentation: true,
        presentationStatus: status as "loading" | "ready",
        onSelectModel: vi.fn(),
      }),
    { initialProps: { status: "loading", value: "" } },
  );
  await act(async () => {
    await result.current.select(connection);
  });
  expect(result.current.pending).toBe(true);
  rerender({ status: "ready", value: "another/model" });
  expect(result.current.pending).toBe(false);
  expect(result.current.error).toContain("retry");
  rerender({ status: "loading", value: "" });
  await act(async () => {
    await result.current.select(connection);
  });
  expect(result.current.pending).toBe(true);
  rerender({ status: "ready", value: encodeCustomModelValue(providerId, "GLM-5.3") });
  expect(result.current.error).toBeNull();
  expect(result.current.pending).toBe(false);
});

it("旧 ready 不是本次展示回执：等待目标 revision，再对不匹配结果结束并报错", async () => {
  const { result, rerender } = renderHook(
    ({ revision, errorRevision }) =>
      useComposerConnectionSwitch({
        workspacePath: "/work",
        agentProvider: "glm",
        normalizedValue: "old/model",
        waitForPresentation: true,
        presentationStatus: "ready",
        presentationRevision: revision,
        presentationErrorRevision: errorRevision,
        onSelectModel: vi.fn(),
      }),
    { initialProps: { revision: 1, errorRevision: 1 as number | undefined } },
  );
  await act(async () => {
    await result.current.select(connection);
  });
  expect(result.current.pending).toBe(true);
  expect(result.current.error).toBeNull();
  rerender({ revision: 2, errorRevision: undefined });
  expect(result.current.pending).toBe(false);
  expect(result.current.error).toContain("retry");
});

it("回滚前另一操作重新选择相同身份，也必须由操作版本 CAS 保护", async () => {
  let settings: Partial<AppSettings> = {
    providerFamilyDomain: "bigmodel",
    providerFamilyDomainUpdatedAt: 1,
    providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
  };
  let writes = 0;
  const update = async (patch: Partial<AppSettings>, expected?: Partial<AppSettings>) => {
    if (++writes === 2)
      settings = {
        ...settings,
        providerFamilyDomainUpdatedAt: (settings.providerFamilyDomainUpdatedAt ?? 0) + 1,
      };
    if (expected?.providerFamilyDomainUpdatedAt !== settings.providerFamilyDomainUpdatedAt)
      throw new Error("Account connection settings changed");
    settings = { ...settings, ...patch };
  };
  await expect(
    persistProviderFamilyConnection({
      family: "bigmodel",
      selection: connection.selection!,
      read: async () => structuredClone(settings),
      update,
      synchronize: async () => {
        throw new Error("offline");
      },
    }),
  ).rejects.toThrow("offline");
  expect(settings.providerFamilyConnectionSelections?.bigmodel).toEqual(connection.selection);
});

it("真实展示 hook 保留旧 ready 时，目标刷新失败也必须结束连接等待并允许重试", async () => {
  let listener: ((candidate: any) => void) | undefined;
  let failPresentation = false;
  let revision = 1;
  const initial = { ...view, revision: 1, effectiveSelection: { providerId, modelId: "GLM-5.3" } };
  mocks.base.modelSelectionService.onDidChange.mockImplementation((callback: any) => {
    listener = callback;
    return { dispose: vi.fn() };
  });
  mocks.base.modelSelectionService.getView.mockImplementation(async (input?: unknown) => {
    if (input && failPresentation) throw new Error("presentation failed");
    return input ? { ...initial, revision } : view;
  });
  mocks.base.providerSettingsService.refresh.mockImplementation(async () => {
    if (revision === 1) listener?.(view);
    revision = 2;
    return undefined;
  });
  const value = encodeCustomModelValue(providerId, "GLM-5.3");
  const hook = renderHook(() => {
    const presentation = useModelSelectionServiceView(
      mocks.base.modelSelectionService as any,
      true,
      "remote-waiting",
      {
        selection: { providerId, modelId: "GLM-5.3" },
      },
    );
    const state = presentation.state;
    return useComposerConnectionSwitch({
      workspacePath: "/work",
      agentProvider: "glm",
      normalizedValue: value,
      onSelectModel: vi.fn(),
      waitForPresentation: true,
      refreshPresentation: presentation.refresh,
      presentationStatus: state.status,
      presentationRevision: state.status === "ready" ? state.view.revision : undefined,
      presentationErrorRevision:
        state.status === "ready" ? state.refreshError?.revision : undefined,
    });
  });
  await waitFor(() => expect(mocks.base.modelSelectionService.getView).toHaveBeenCalled());
  failPresentation = true;
  await act(async () => {
    await hook.result.current.select(connection);
  });
  await waitFor(() => expect(hook.result.current.pending).toBe(false));
  expect(hook.result.current.error).toContain("retry");
  failPresentation = false;
  await act(async () => {
    await hook.result.current.select(connection);
  });
  expect(mocks.update).toHaveBeenCalledTimes(2);
  expect(hook.result.current.pending).toBe(false);
  expect(hook.result.current.error).toBeNull();
});

it("真实展示 hook 的旧读取失败不能否定新输入已成功的连接切换", async () => {
  let rejectOld!: (error: Error) => void;
  let oldStarted = false;
  let armed = false;
  const effective = { ...view, effectiveSelection: { providerId, modelId: "GLM-5.3" } };
  mocks.base.modelSelectionService.getView.mockImplementation((input?: unknown) => {
    if (input && armed && !oldStarted) {
      oldStarted = true;
      return new Promise((_resolve, reject) => {
        rejectOld = reject;
      });
    }
    return Promise.resolve(effective);
  });
  const value = encodeCustomModelValue(providerId, "GLM-5.3");
  const hook = renderHook(
    ({ reasoning }) => {
      const presentation = useModelSelectionServiceView(
        mocks.base.modelSelectionService as any,
        true,
        "remote-waiting",
        {
          selection: { providerId, modelId: "GLM-5.3", options: { reasoningLevel: reasoning } },
        },
      );
      const state = presentation.state;
      return {
        state,
        connection: useComposerConnectionSwitch({
          workspacePath: "/work",
          agentProvider: "glm",
          normalizedValue: value,
          onSelectModel: vi.fn(),
          waitForPresentation: true,
          refreshPresentation: presentation.refresh,
          presentationStatus: state.status,
          presentationRevision: state.status === "ready" ? state.view.revision : undefined,
          presentationErrorRevision:
            state.status === "ready" ? state.refreshError?.revision : undefined,
        }),
      };
    },
    { initialProps: { reasoning: "disabled" } },
  );
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  armed = true;
  let operation!: Promise<void>;
  await act(async () => {
    operation = hook.result.current.connection.select(connection);
  });
  await waitFor(() => expect(oldStarted).toBe(true));
  hook.rerender({ reasoning: "enabled" });
  await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  await act(async () => {
    rejectOld(new Error("obsolete input failed"));
    await operation;
  });
  await waitFor(() => expect(hook.result.current.connection.pending).toBe(false));
  expect(hook.result.current.connection.error).toBeNull();
});
