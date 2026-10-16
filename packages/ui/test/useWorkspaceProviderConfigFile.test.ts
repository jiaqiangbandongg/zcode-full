import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ILegacyTaskService } from "@zcode/services";
import {
  resolveWorkspaceProviderConfigZCodeService,
  useWorkspaceProviderConfigFile,
} from "@/hooks/useWorkspaceProviderConfigFile.js";

const { stableWorkspaceZCodeService } = vi.hoisted(() => ({
  stableWorkspaceZCodeService: {
    getWorkspaceProviderConfigFile: vi.fn(),
  },
}));

vi.mock("@/hooks/useZCodeTaskService.js", () => ({
  useZCodeTaskService: () => stableWorkspaceZCodeService,
}));

vi.mock("@/hooks/useResolvedRemoteWorkspaceSessionId.js", () => ({
  useResolvedRemoteWorkspaceSessionId: () => null,
}));

vi.mock("@/store/remoteWorkspaceSessionStore.js", () => ({
  useRemoteWorkspaceSessionStore: (
    selector: (state: { baseServices: null }) => unknown,
  ) => selector({ baseServices: null }),
}));

function createMockZCodeService(tag: string): ILegacyTaskService {
  return {
    // 这里只需要 identity 区分，不会真的调用方法。
    __tag: tag,
  } as unknown as ILegacyTaskService;
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
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
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
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

describe("resolveWorkspaceProviderConfigZCodeService", () => {
  afterEach(() => {
    stableWorkspaceZCodeService.getWorkspaceProviderConfigFile.mockReset();
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("workspace 作用域始终使用 workspace ZCode session service", () => {
    const workspaceZCodeService = createMockZCodeService("workspace");
    const baseZCodeService = createMockZCodeService("base");

    const resolved = resolveWorkspaceProviderConfigZCodeService({
      configuredServiceScope: "workspace",
      workspaceZCodeService,
      baseZCodeService,
      remoteSessionId: "remote-session-1",
    });

    expect(resolved).toBe(workspaceZCodeService);
  });

  it("base 作用域优先使用 base ZCode session service", () => {
    const workspaceZCodeService = createMockZCodeService("workspace");
    const baseZCodeService = createMockZCodeService("base");

    const resolved = resolveWorkspaceProviderConfigZCodeService({
      configuredServiceScope: "base",
      workspaceZCodeService,
      baseZCodeService,
      remoteSessionId: "remote-session-1",
    });

    expect(resolved).toBe(baseZCodeService);
  });

  it("base 作用域在远程会话且 base service 缺失时返回 null，避免误回退远程路径", () => {
    const workspaceZCodeService = createMockZCodeService("workspace");

    const resolved = resolveWorkspaceProviderConfigZCodeService({
      configuredServiceScope: "base",
      workspaceZCodeService,
      baseZCodeService: null,
      remoteSessionId: "remote-session-1",
    });

    expect(resolved).toBeNull();
  });

  it("base 作用域在本地会话且 base service 缺失时回退 workspace service", () => {
    const workspaceZCodeService = createMockZCodeService("workspace");

    const resolved = resolveWorkspaceProviderConfigZCodeService({
      configuredServiceScope: "base",
      workspaceZCodeService,
      baseZCodeService: null,
      remoteSessionId: null,
    });

    expect(resolved).toBe(workspaceZCodeService);
  });

  it("memoizes the returned provider config object across parent rerenders when fields are unchanged", () => {
    const observedResults: Array<ReturnType<typeof useWorkspaceProviderConfigFile>> = [];
    const root: Root = createRoot(installMinimalDom());

    function Probe({ tick }: { tick: number }) {
      const result = useWorkspaceProviderConfigFile(
        "/workspace",
        "codex",
        null,
        undefined,
        { enabled: false },
      );
      observedResults.push(result);
      return createElement("span", null, tick);
    }

    act(() => {
      root.render(createElement(Probe, { tick: 1 }));
    });
    act(() => {
      root.render(createElement(Probe, { tick: 2 }));
    });

    expect(observedResults).toHaveLength(3);
    expect(observedResults[2]).toBe(observedResults[1]);

    act(() => {
      root.unmount();
    });
  });
});
