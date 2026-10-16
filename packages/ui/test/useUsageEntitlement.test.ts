import { BigModelUsageQuotaProvider } from "../../services/src/usage-stats/providers/bigmodelUsageQuotaProvider.js";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import type { UsageEntitlementSnapshot, ZCodeAccountAccess } from "@zcode/shared";
import { readCachedUsageEntitlementSnapshot } from "@/lib/usageEntitlementCache.js";
import {
  buildEntitlementFreshnessKey,
  hasSharedEntitlementFailure,
  shouldDeferSharedEntitlementRefresh,
  readSharedEntitlementSnapshot,
} from "@/lib/usageEntitlementRefreshPolicy.js";
import type { IUsageStatsService, IServiceAccessor } from "@zcode/services";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useUsageEntitlement,
  useUsageEntitlementWithService,
  withUsageEntitlementTimeout,
} from "@/hooks/useUsageEntitlement.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import {
  registerBaseWorkspaceServices,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";

function createMinimalElement(ownerDocument?: Document, tagName = "div"): Element {
  const element = {
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    addEventListener: () => {},
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const storage = new Map<string, string>();
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
    visibilityState: "visible",
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    clearInterval,
    clearTimeout,
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => {
        storage.delete(key);
      },
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
    Node: function Node() {},
    removeEventListener: () => {},
    setInterval,
    setTimeout,
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

function createSnapshot(params: {
  organizationId: string;
  projectId: string;
}): UsageEntitlementSnapshot {
  return {
    generatedAt: Date.now(),
    authenticated: true,
    context: {
      scope: "team",
      organizationId: params.organizationId,
      projectId: params.projectId,
    },
    provider: {
      id: "account:bigmodel-individual-coding-plan",
      name: "BigModel Coding Plan",
    },
    remaining: {
      count: params.projectId === "proj-a" ? 10 : 20,
      isShow: true,
    },
    subscription: null,
    quota: {
      level: null,
      limits: [],
    },
  };
}

function flushPromises() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useUsageEntitlement timeout", () => {
  it("权益查询长时间不返回时进入失败路径", async () => {
    vi.useFakeTimers();
    try {
      const request = new Promise<string>(() => {});
      const result = withUsageEntitlementTimeout(request, 5);
      const assertion = expect(result).rejects.toThrow("usage_entitlement_request_timeout:5");

      await vi.advanceTimersByTimeAsync(5);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("权益查询正常返回时清理超时计时器", async () => {
    vi.useFakeTimers();
    try {
      await expect(withUsageEntitlementTimeout(Promise.resolve("ok"), 5)).resolves.toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useUsageEntitlement team context refresh", () => {
  it("远端 workspace 等待 services 时权益查询仍走 app-global base host", async () => {
    const baseGetEntitlementSnapshot = vi.fn(async () =>
      createSnapshot({ organizationId: "org-base", projectId: "proj-base" }),
    );
    const remoteGetEntitlementSnapshot = vi.fn(async () =>
      createSnapshot({ organizationId: "org-remote", projectId: "proj-remote" }),
    );
    const baseServices = {
      usageStatsService: { getEntitlementSnapshot: baseGetEntitlementSnapshot },
    } as unknown as IServiceAccessor;
    const remoteContextServices = {
      usageStatsService: { getEntitlementSnapshot: remoteGetEntitlementSnapshot },
    } as unknown as IServiceAccessor;
    registerBaseWorkspaceServices(baseServices);

    function Probe() {
      useUsageEntitlement({
        enabled: true,
        preferredProviderId: "account:bigmodel-individual-coding-plan",
        cacheKey: "base-host-routing",
        refreshOnMount: true,
      });
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    try {
      await act(async () => {
        root.render(
          createElement(ServiceProvider, { services: remoteContextServices }, createElement(Probe)),
        );
        await flushPromises();
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
      useRemoteWorkspaceSessionStore.setState({ baseServices: null });
    }

    expect(baseGetEntitlementSnapshot).toHaveBeenCalledTimes(1);
    expect(remoteGetEntitlementSnapshot).not.toHaveBeenCalled();
  });

  it("Team Plan freshness key 变化后会重新请求新团队权益", async () => {
    const calls: Array<{ organizationId?: string | null; projectId?: string | null }> = [];
    const usageStatsService = {
      getEntitlementSnapshot: vi.fn(async (request) => {
        calls.push({
          organizationId: request.accountAccess?.organizationId,
          projectId: request.accountAccess?.projectId,
        });
        return createSnapshot({
          organizationId: request.accountAccess?.organizationId ?? "",
          projectId: request.accountAccess?.projectId ?? "",
        });
      }),
    };
    const services = {
      usageStatsService,
    } as unknown as IServiceAccessor;

    const accountAccessByProject = new Map<string, ZCodeAccountAccess>();
    function getTeamAccess(organizationId: string, projectId: string): ZCodeAccountAccess {
      const key = `${organizationId}:${projectId}`;
      const existing = accountAccessByProject.get(key);
      if (existing) return existing;
      const access: ZCodeAccountAccess = {
        type: "zhipu-account",
        family: "bigmodel",
        planKind: "team-coding-plan",
        productId: "product-team",
        organizationId,
        projectId,
      };
      accountAccessByProject.set(key, access);
      return access;
    }

    function Probe(props: { organizationId: string; projectId: string }) {
      useUsageEntitlement({
        enabled: true,
        preferredProviderId: "account:bigmodel-team-coding-plan",
        accountAccess: getTeamAccess(props.organizationId, props.projectId),
        allowDisabledPreferredProvider: true,
        requirePreferredProvider: true,
        allowEnvApiKey: false,
        cacheKey: `team:${props.organizationId}:${props.projectId}`,
        refreshOnMount: true,
      });
      return null;
    }

    function renderProbe(props: { organizationId: string; projectId: string }): ReactElement {
      return createElement(ServiceProvider, { services }, createElement(Probe, props));
    }

    const root: Root = createRoot(installMinimalDom());
    try {
      await act(async () => {
        root.render(renderProbe({ organizationId: "org-a", projectId: "proj-a" }));
        await flushPromises();
      });
      await act(async () => {
        root.render(renderProbe({ organizationId: "org-b", projectId: "proj-b" }));
        await flushPromises();
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
    }

    expect(calls).toEqual([
      { organizationId: "org-a", projectId: "proj-a" },
      { organizationId: "org-b", projectId: "proj-b" },
    ]);
  });
});

describe("刷新失败保留已确认订阅", () => {
  it.each(["personal", "team"] as const)(
    "%s 真实订阅服务失败保留快照和退避，明确无套餐才清除",
    async (scope) => {
      let mode: "active" | "failure" | "unknown" | "none" = "active";
      const accountAccess: ZCodeAccountAccess =
        scope === "team"
          ? {
              type: "zhipu-account",
              family: "bigmodel",
              planKind: "team-coding-plan",
              organizationId: "org",
              projectId: "project",
            }
          : { type: "zhipu-account", family: "bigmodel", planKind: "individual-coding-plan" };
      const providerId = `account:bigmodel-${scope === "team" ? "team" : "individual"}-coding-plan`;
      const provider = new BigModelUsageQuotaProvider({
        env: { ZCODE_ENV: "production" },
        credentialService: { load: async () => "business" },
        accountRequestAuthService: {
          resolveAccessCurrent: vi.fn(),
          resolveCurrent: vi.fn(async () => ({ apiKey: "personal.secret" })),
          assertCurrent: vi.fn(),
        },
        apiClient: {
          request: vi.fn(async (url) => {
            if (mode === "failure") throw new Error("network offline");
            const subscription =
              String(url).includes("subscription/list") ||
              String(url).includes("querySubscribeDetail");
            // quota 始终失败，确认有效订阅仍可独立展示。
            if (!subscription) throw new Error("quota offline");
            const data =
              mode === "unknown"
                ? { invalid: true }
                : scope === "team"
                  ? {
                      hasSubscription: mode !== "none",
                      status: "EFFECTIVE",
                      memberGrantStatus: "VALID",
                      productId: "coding",
                      productName: "Team Coding",
                    }
                  : mode === "none"
                    ? []
                    : [
                        {
                          productId: "coding",
                          productName: "GLM Coding Lite",
                          status: "VALID",
                          inCurrentPeriod: true,
                        },
                      ];
            return new Response(JSON.stringify({ success: true, data }));
          }),
        },
      });
      const getEntitlementSnapshot = vi.fn(() =>
        provider.getSnapshotForRequest({ preferredProviderId: providerId, accountAccess }),
      );
      const usageStatsService = { getEntitlementSnapshot } as unknown as IUsageStatsService;
      const cacheKey = `service-failure-${scope}`;
      const freshnessKey = buildEntitlementFreshnessKey({
        cacheKey,
        options: {
          includeSubscription: false,
          preferredProviderId: providerId,
          accountAccess,
          allowDisabledPreferredProvider: false,
          requirePreferredProvider: false,
        },
      });
      let state!: ReturnType<typeof useUsageEntitlementWithService>;
      function Probe() {
        state = useUsageEntitlementWithService(usageStatsService, {
          enabled: true,
          cacheKey,
          preferredProviderId: providerId,
          accountAccess,
          refreshOnMount: true,
        });
        return null;
      }
      const root = createRoot(installMinimalDom());
      try {
        await act(async () => {
          root.render(createElement(Probe));
          await flushPromises();
        });
        const confirmed = state.snapshot;
        expect(confirmed?.subscription?.details[0]?.productId).toBe("coding");
        for (const failure of ["failure", "unknown"] as const) {
          mode = failure;
          await act(async () => {
            await state.refresh({ force: true, reason: "manual" });
          });
          expect(state.snapshot).toEqual(confirmed);
          expect(state.error).toBeTruthy();
          expect(readCachedUsageEntitlementSnapshot({ cacheKey })).toEqual(confirmed);
          expect(hasSharedEntitlementFailure({ usageStatsService, freshnessKey })).toBe(true);
          expect(
            shouldDeferSharedEntitlementRefresh({
              usageStatsService,
              freshnessKey,
              now: Date.now(),
            }),
          ).toBe(true);
        }
        mode = "none";
        await act(async () => {
          await state.refresh({ force: true, reason: "manual" });
        });
        expect(state.error).toBeNull();
        expect(state.snapshot?.subscription).toBeNull();
        expect(state.snapshot?.unavailableReason).toBe("no_plan");
        expect(readCachedUsageEntitlementSnapshot({ cacheKey })?.subscription).toBeNull();
        expect(hasSharedEntitlementFailure({ usageStatsService, freshnessKey })).toBe(false);
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
  it("手动刷新遇到 429 保留同一身份的套餐，并暴露错误；购买刷新传递失效标记", async () => {
    const snapshot = createSnapshot({ organizationId: "org", projectId: "project" });
    snapshot.subscription = {
      identityType: "unknown",
      identityMasked: null,
      details: [{ productId: "start", productName: "Start Plan" }],
    };
    const getEntitlementSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error("HTTP 429"))
      .mockResolvedValue(snapshot);
    const services = {
      usageStatsService: { getEntitlementSnapshot },
    } as unknown as IServiceAccessor;
    registerBaseWorkspaceServices(services);
    let state!: ReturnType<typeof useUsageEntitlement>;
    function Probe() {
      state = useUsageEntitlement({
        enabled: true,
        cacheKey: "keep-confirmed-subscription",
        preferredProviderId: "account:bigmodel-start-plan",
        refreshOnMount: true,
      });
      return null;
    }
    const root = createRoot(installMinimalDom());
    try {
      await act(async () => {
        root.render(createElement(ServiceProvider, { services }, createElement(Probe)));
        await flushPromises();
      });
      await act(async () => {
        await state.refresh({ force: true, reason: "manual" });
      });
      expect(state.snapshot).toBe(snapshot);
      expect(state.error).toBe("HTTP 429");
      await act(async () => {
        await state.refresh({ force: true, reason: "purchase" });
      });
      expect(getEntitlementSnapshot.mock.lastCall?.[0]).toMatchObject({
        invalidateBalanceCache: true,
      });
    } finally {
      await act(async () => root.unmount());
      useRemoteWorkspaceSessionStore.setState({ baseServices: null });
    }
  });
});

describe("跨组件购买刷新代次", () => {
  it.each(["success", "failure"])("购买成功后忽略旧请求的 %s，隔离其他身份", async (outcome) => {
    const pending: Array<{
      resolve: (s: UsageEntitlementSnapshot) => void;
      reject: (e: Error) => void;
    }> = [];
    const service = {
      getEntitlementSnapshot: vi.fn(
        () =>
          new Promise<UsageEntitlementSnapshot>((resolve, reject) =>
            pending.push({ resolve, reject }),
          ),
      ),
    } as unknown as IUsageStatsService;
    const states: Array<ReturnType<typeof useUsageEntitlementWithService>> = [];
    const requestOptions = {
      includeSubscription: false,
      preferredProviderId: "account:bigmodel-start-plan",
      allowDisabledPreferredProvider: false,
      requirePreferredProvider: false,
    };
    const cacheKey = "purchase-generation";
    const freshnessKey = buildEntitlementFreshnessKey({ cacheKey, options: requestOptions });
    function Probe({ index }: { index: number }) {
      states[index] = useUsageEntitlementWithService(service, {
        ...requestOptions,
        preferredProviderId: index === 2 ? "other-provider" : requestOptions.preferredProviderId,
        cacheKey: index === 2 ? "other-identity" : cacheKey,
      });
      return null;
    }
    const root = createRoot(installMinimalDom());
    const fresh = createSnapshot({ organizationId: "org", projectId: "new" });
    fresh.subscription = {
      identityType: "unknown",
      identityMasked: null,
      details: [{ productId: "start", productName: "Start Plan" }],
    };
    const old = createSnapshot({ organizationId: "org", projectId: "old" });
    const other = createSnapshot({ organizationId: "other", projectId: "other" });
    try {
      await act(async () => {
        root.render(
          createElement(
            "div",
            null,
            ...[0, 1, 2].map((index) => createElement(Probe, { index, key: index })),
          ),
        );
      });
      let oldRequest!: Promise<void>;
      let otherRequest!: Promise<void>;
      let purchase!: Promise<void>;
      await act(async () => {
        oldRequest = states[0]!.refresh();
        otherRequest = states[2]!.refresh();
      });
      expect(pending).toHaveLength(2);
      await act(async () => {
        purchase = states[1]!.refresh({ reason: "purchase", force: true });
      });
      await act(async () => {
        pending[2]!.resolve(fresh);
        await purchase;
      });
      // 购买后的普通刷新也不能重新加入仍未完成的旧代次请求。
      let followUp!: Promise<void>;
      await act(async () => {
        followUp = states[1]!.refresh();
      });
      expect(pending).toHaveLength(4);
      await act(async () => {
        pending[3]!.resolve(fresh);
        await followUp;
      });
      await act(async () => {
        if (outcome === "success") pending[0]!.resolve(old);
        else pending[0]!.reject(new Error("old HTTP 429"));
        pending[1]!.resolve(other);
        await Promise.all([oldRequest, otherRequest]);
      });
      for (const state of states.slice(0, 2)) {
        expect(state.snapshot).toEqual(fresh);
        expect(state.error).toBeNull();
        expect(state.loading).toBe(false);
      }
      expect(states[2]!.snapshot).toEqual(other);
      expect(readCachedUsageEntitlementSnapshot({ cacheKey })).toEqual(fresh);
      expect(readSharedEntitlementSnapshot({ usageStatsService: service, freshnessKey })).toEqual(
        fresh,
      );
      expect(hasSharedEntitlementFailure({ usageStatsService: service, freshnessKey })).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
