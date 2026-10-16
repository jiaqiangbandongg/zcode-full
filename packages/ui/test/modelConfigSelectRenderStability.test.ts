import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";

const {
  dropdownContentCalls,
  dropdownItemCalls,
  radioItemCalls,
  subContentCalls,
  subTriggerCalls,
} = vi.hoisted(() => ({
  dropdownContentCalls: [] as Array<Record<string, unknown>>,
  dropdownItemCalls: [] as Array<Record<string, unknown>>,
  radioItemCalls: [] as Array<Record<string, unknown>>,
  subContentCalls: [] as Array<Record<string, unknown>>,
  subTriggerCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("lucide-react", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    AlertCircle: createIcon("alert-circle"),
    CheckIcon: createIcon("check"),
    ChevronDownIcon: createIcon("chevron-down"),
    LoaderIcon: createIcon("loader"),
    // Bugfix: ModelConfigSelect 的 trigger 会无条件渲染 PackageIcon；封闭 mock 漏掉它时，
    // render stability 用例会在进入菜单延迟渲染断言前直接崩溃。
    PackageIcon: createIcon("package"),
  };
});

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
}));

vi.mock("@/chat-input-toolbar/RollingToolbarLabel.js", () => ({
  RollingToolbarLabel: ({ label }: { label: string }) =>
    createElement("span", null, label),
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuContent: ({ children, ...props }: { children?: ReactNode }) => {
    dropdownContentCalls.push(props);
    return createElement("div", props, children);
  },
  DropdownMenuItem: ({ children, ...props }: { children?: ReactNode }) => {
    dropdownItemCalls.push(props);
    return createElement("div", props, children);
  },
  DropdownMenuRadioGroup: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuRadioItem: ({ children, ...props }: { children?: ReactNode }) => {
    radioItemCalls.push(props);
    return createElement("div", props, children);
  },
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuSub: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuSubContent: ({ children, ...props }: { children?: ReactNode }) => {
    subContentCalls.push(props);
    return createElement("div", props, children);
  },
  DropdownMenuSubTrigger: ({
    children,
    ...props
  }: {
    children?: ReactNode;
  }) => {
    subTriggerCalls.push(props);
    return createElement("div", props, children);
  },
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
}));

vi.mock("@/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
  TooltipContent: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
  TooltipProvider: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
  TooltipTrigger: ({ children }: { children?: ReactNode }) =>
    createElement("span", null, children),
}));

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
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    querySelector: () => null,
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

const modelGroups: ModelSelectGroup[] = [
  {
    key: "codex",
    label: "Codex",
    items: [
      { key: "gpt-5", value: "gpt-5", name: "GPT-5" },
      { key: "gpt-5-mini", value: "gpt-5-mini", name: "GPT-5 Mini" },
    ],
  },
];

describe("ModelConfigSelect render stability", () => {
  afterEach(() => {
    dropdownContentCalls.length = 0;
    dropdownItemCalls.length = 0;
    radioItemCalls.length = 0;
    subContentCalls.length = 0;
    subTriggerCalls.length = 0;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("defers model menu item rendering until the dropdown is open", async () => {
    const { ModelConfigSelect } = await import("@/ModelConfigSelect.js");
    const root: Root = createRoot(installMinimalDom());
    const baseProps = {
      focusSelectorOnClose: null,
      isItemLocked: () => false,
      lockReasonMessage: "locked",
      modelGroups,
      normalizedValue: "gpt-5",
      onValueChange: vi.fn(),
      showManageModelsAction: false,
      tooltipTitle: "model",
      triggerLabel: "GPT-5",
    };

    act(() => {
      root.render(createElement(ModelConfigSelect, baseProps));
    });

    expect(radioItemCalls).toHaveLength(0);

    await act(async () => {
      root.render(
        createElement(ModelConfigSelect, {
          ...baseProps,
          openRequestKey: 1,
        }),
      );
    });

    expect(radioItemCalls).toHaveLength(2);

    act(() => {
      root.unmount();
    });
  });

  it("renders a flat model allowlist without a provider submenu", async () => {
    const { ModelConfigSelect } = await import("@/ModelConfigSelect.js");
    const root: Root = createRoot(installMinimalDom());
    const baseProps = {
      focusSelectorOnClose: null,
      isItemLocked: () => false,
      lockReasonMessage: "",
      modelGroups,
      normalizedValue: "gpt-5",
      onValueChange: vi.fn(),
      showManageModelsAction: false,
      showProviderLevel: false,
      tooltipTitle: "model",
      triggerLabel: "GPT-5",
    };

    act(() => {
      root.render(createElement(ModelConfigSelect, baseProps));
    });
    await act(async () => {
      root.render(
        createElement(ModelConfigSelect, {
          ...baseProps,
          openRequestKey: 1,
        }),
      );
    });

    expect(radioItemCalls).toHaveLength(2);
    expect(subTriggerCalls).toHaveLength(0);

    const onCloseAutoFocus = dropdownContentCalls.at(-1)?.onCloseAutoFocus;
    expect(onCloseAutoFocus).toBeTypeOf("function");
    const preventDefault = vi.fn();
    (onCloseAutoFocus as (event: { preventDefault: () => void }) => void)({
      preventDefault,
    });
    expect(preventDefault).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("keeps the provider submenu interaction and accepts a narrower mobile width", async () => {
    const { ModelConfigSelect } = await import("@/ModelConfigSelect.js");
    const root: Root = createRoot(installMinimalDom());
    const baseProps = {
      focusSelectorOnClose: null,
      isItemLocked: () => false,
      lockReasonMessage: "",
      modelGroups,
      normalizedValue: "gpt-5",
      onValueChange: vi.fn(),
      providerSubmenuClassName:
        "w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)",
      showManageModelsAction: false,
      tooltipTitle: "model",
      triggerLabel: "GPT-5",
    };

    act(() => {
      root.render(createElement(ModelConfigSelect, baseProps));
    });
    await act(async () => {
      root.render(
        createElement(ModelConfigSelect, {
          ...baseProps,
          openRequestKey: 1,
        }),
      );
    });

    expect(radioItemCalls).toHaveLength(2);
    expect(subTriggerCalls).toHaveLength(1);
    expect(subContentCalls.at(-1)?.className).toContain("w-40");
    expect(subContentCalls.at(-1)?.className).toContain("min-w-0");
    expect(subContentCalls.at(-1)?.className).toContain(
      "max-w-(--radix-dropdown-menu-content-available-width)",
    );
    expect(subContentCalls.at(-1)?.className).not.toContain("w-48");

    act(() => {
      root.unmount();
    });
  });

  it("renders selected footer actions alongside manage models", async () => {
    const { ModelConfigSelect } = await import("@/ModelConfigSelect.js");
    const root: Root = createRoot(installMinimalDom());
    const onInherit = vi.fn();
    const onManageModels = vi.fn();

    act(() => {
      root.render(
        createElement(ModelConfigSelect, {
          focusSelectorOnClose: null,
          footerActions: [
            {
              key: "inherit",
              label: "Inherit default",
              onSelect: onInherit,
              selected: true,
            },
          ],
          isItemLocked: () => false,
          lockReasonMessage: "locked",
          manageModelsLabel: "Manage models",
          modelGroups,
          normalizedValue: "gpt-5",
          onManageModels,
          onValueChange: vi.fn(),
          showManageModelsAction: true,
          tooltipTitle: "model",
          triggerLabel: "GPT-5",
        }),
      );
    });

    await act(async () => {
      root.render(
        createElement(ModelConfigSelect, {
          focusSelectorOnClose: null,
          footerActions: [
            {
              key: "inherit",
              label: "Inherit default",
              onSelect: onInherit,
              selected: true,
            },
          ],
          isItemLocked: () => false,
          lockReasonMessage: "locked",
          manageModelsLabel: "Manage models",
          modelGroups,
          normalizedValue: "gpt-5",
          onManageModels,
          onValueChange: vi.fn(),
          openRequestKey: 1,
          showManageModelsAction: true,
          tooltipTitle: "model",
          triggerLabel: "GPT-5",
        }),
      );
    });

    expect(dropdownItemCalls).toEqual([
      expect.objectContaining({
        "data-model-footer-action": "inherit",
        "data-model-footer-action-selected": "true",
      }),
      expect.objectContaining({
        "data-model-footer-action": "manage-models",
      }),
    ]);

    act(() => {
      root.unmount();
    });
  });
});
