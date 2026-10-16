import type { ZCodeElicitationRequest } from "@zcode/shared";
import { act, createElement, forwardRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElicitationDialog } from "../src/ElicitationDialog.js";

type TestEvent = {
  bubbles?: boolean;
  button?: number;
  currentTarget?: TestElement;
  defaultPrevented?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  target?: TestElement;
  type: string;
};

type TestEventHandler = (event: TestEvent) => void;

type TestElement = Element & {
  __attrs: Map<string, string>;
  __listeners: Map<string, TestEventHandler[]>;
  childNodes: TestElement[];
  dispatchEvent: (event: TestEvent) => boolean;
  parentNode: TestElement | null;
};

vi.mock("lucide-react", () => {
  const Icon = (props: Record<string, unknown>) => createElement("svg", props);
  return {
    CheckIcon: Icon,
    ChevronDown: Icon,
    ChevronLeft: Icon,
    ChevronRight: Icon,
    ChevronUp: Icon,
    Info: Icon,
  };
});

vi.mock("@/components/ui/badge.js", () => ({
  Badge: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/input.js", () => ({
  Input: forwardRef<HTMLInputElement, Record<string, unknown>>((props, ref) =>
    createElement("input", { ...props, ref }),
  ),
}));

vi.mock("@/InteractionRequestOriginBadge.js", () => ({
  InteractionRequestOriginBadge: () => null,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

function createRequest(requestId: string): ZCodeElicitationRequest {
  return {
    type: "elicitation_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId,
    message: "请选择方案",
    options: [],
    questions: [
      {
        question: "请选择方案",
        header: "方案",
        options: [
          { value: "fast", label: "快速" },
          { value: "safe", label: "稳妥" },
        ],
      },
      {
        question: "请选择保障项",
        header: "保障项",
        options: [
          { value: "tests", label: "测试" },
          { value: "docs", label: "文档" },
        ],
      },
    ],
  };
}

function createSingleQuestionRequest(requestId: string): ZCodeElicitationRequest {
  return {
    type: "elicitation_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId,
    message: "请选择方案",
    options: [{ value: "fast", label: "快速" }],
    questions: [
      {
        question: "请选择方案",
        header: "方案",
        options: [{ value: "fast", label: "快速" }],
      },
    ],
  };
}

function createPlanApprovalRequest(requestId: string): ZCodeElicitationRequest {
  return {
    type: "elicitation_request",
    taskId: "task-1",
    traceId: "trace-1",
    requestId,
    message: "Review this implementation plan.",
    header: "Plan",
    options: [
      {
        value: "approve",
        label: "Approve",
        description: "Exit plan mode and start implementation.",
      },
    ],
    questions: [
      {
        question: "Review this implementation plan.",
        header: "Plan",
        options: [
          {
            value: "approve",
            label: "Approve",
            description: "Exit plan mode and start implementation.",
          },
        ],
      },
    ],
    schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
  };
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    __attrs: new Map<string, string>(),
    __listeners: new Map<string, TestEventHandler[]>(),
    addEventListener: (type: string, handler: TestEventHandler) => {
      const handlers = element.__listeners.get(type) ?? [];
      handlers.push(handler);
      element.__listeners.set(type, handlers);
    },
    appendChild: (child: TestElement) => {
      child.parentNode = element as unknown as TestElement;
      element.childNodes.push(child);
      return child;
    },
    childNodes: [] as TestElement[],
    dispatchEvent: (event: TestEvent) => {
      event.target ??= element as unknown as TestElement;
      event.preventDefault ??= () => {
        event.defaultPrevented = true;
      };
      event.stopPropagation ??= () => {};
      let current: TestElement | null = element as unknown as TestElement;
      while (current) {
        event.currentTarget = current;
        for (const handler of current.__listeners.get(event.type) ?? []) {
          handler(event);
        }
        if (!event.bubbles) break;
        current = current.parentNode;
      }
      return !event.defaultPrevented;
    },
    focus: () => {},
    getAttribute: (name: string) => element.__attrs.get(name) ?? null,
    insertBefore: (child: TestElement, beforeChild?: TestElement | null) => {
      child.parentNode = element as unknown as TestElement;
      const beforeIndex = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (beforeIndex >= 0) {
        element.childNodes.splice(beforeIndex, 0, child);
      } else {
        element.childNodes.push(child);
      }
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as TestElement | null,
    removeAttribute: (name: string) => {
      element.__attrs.delete(name);
    },
    removeChild: (child: TestElement) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      child.parentNode = null;
      return child;
    },
    removeEventListener: (type: string, handler: TestEventHandler) => {
      element.__listeners.set(
        type,
        (element.__listeners.get(type) ?? []).filter((item) => item !== handler),
      );
    },
    setAttribute: (name: string, value: string) => {
      element.__attrs.set(name, String(value));
    },
    style: {},
    tagName: tagName.toUpperCase(),
    value: "",
  };
  return element as unknown as TestElement;
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
    removeEventListener: () => {},
  } as unknown as Document;
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  const windowMock = {
    addEventListener: () => {},
    cancelAnimationFrame: () => {},
    clearTimeout,
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    requestAnimationFrame,
    setTimeout,
  };
  Object.assign(globalThis, {
    cancelAnimationFrame: () => {},
    document: documentMock,
    HTMLElement: windowMock.HTMLElement,
    HTMLIFrameElement: windowMock.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    Node: windowMock.Node,
    requestAnimationFrame,
    window: windowMock,
  });
  return createMinimalElement(documentMock);
}

function findOptions(node: unknown): TestElement[] {
  if (typeof node !== "object" || node === null) return [];
  const treeNode = node as {
    childNodes?: unknown[];
    getAttribute?: (name: string) => string | null;
  };
  const matches = treeNode.getAttribute?.("role") === "option" ? [node as TestElement] : [];
  return [...matches, ...(treeNode.childNodes ?? []).flatMap((child) => findOptions(child))];
}

function findByAttribute(node: unknown, name: string, value: string): TestElement | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const treeNode = node as {
    childNodes?: unknown[];
    getAttribute?: (attributeName: string) => string | null;
  };
  if (treeNode.getAttribute?.(name) === value) return node as TestElement;
  for (const child of treeNode.childNodes ?? []) {
    const match = findByAttribute(child, name, value);
    if (match) return match;
  }
  return undefined;
}

function findByTagName(node: unknown, tagName: string): TestElement[] {
  if (typeof node !== "object" || node === null) return [];
  const treeNode = node as {
    childNodes?: unknown[];
    tagName?: string;
  };
  const matches = treeNode.tagName === tagName.toUpperCase() ? [node as TestElement] : [];
  return [
    ...matches,
    ...(treeNode.childNodes ?? []).flatMap((child) => findByTagName(child, tagName)),
  ];
}

function clickFirstOption(container: TestElement) {
  const option = findOptions(container)[0];
  expect(option).toBeDefined();
  option?.dispatchEvent({ bubbles: true, button: 0, type: "click" });
}

function clickPrimaryAction(container: TestElement) {
  const footer = findByAttribute(container, "data-elicitation-dialog-footer", "true");
  const buttons = findByTagName(footer, "button");
  const primaryAction = buttons.at(-1);
  expect(primaryAction).toBeDefined();
  primaryAction?.dispatchEvent({ bubbles: true, button: 0, type: "click" });
}

function changeCustomAnswer(container: TestElement, value: string) {
  const input = findByAttribute(
    container,
    "placeholder",
    "chat.elicitation.customAnswer.placeholder",
  );
  expect(input).toBeDefined();
  const inputRecord = input as unknown as Record<string, unknown>;
  const reactPropsKey = Object.keys(inputRecord).find((key) => key.startsWith("__reactProps$"));
  const reactProps = reactPropsKey
    ? (inputRecord[reactPropsKey] as { onChange?: (event: { target: { value: string } }) => void })
    : undefined;
  expect(reactProps?.onChange).toBeTypeOf("function");
  reactProps?.onChange?.({ target: { value } });
}

let mountedRoot: Root | null = null;

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  for (const key of [
    "cancelAnimationFrame",
    "document",
    "HTMLElement",
    "HTMLIFrameElement",
    "IS_REACT_ACT_ENVIRONMENT",
    "Node",
    "requestAnimationFrame",
    "window",
  ]) {
    Reflect.deleteProperty(globalThis, key);
  }
});

describe("ElicitationDialog request identity", () => {
  it("计划审批空反馈点击主提交等同批准，普通单选题无交互点提交保持空答案", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const onRespond = vi.fn();

    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, {
          request: createPlanApprovalRequest("plan-primary-submit"),
          onRespond,
        }),
      );
    });
    act(() => clickPrimaryAction(container));

    expect(onRespond).toHaveBeenLastCalledWith("plan-primary-submit", "accept", {
      answers: { "Review this implementation plan.": "approve" },
      answer_0: "approve",
      answer: "approve",
    });

    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, {
          request: createSingleQuestionRequest("ask-primary-submit"),
          onRespond,
        }),
      );
    });
    act(() => clickPrimaryAction(container));

    // 修复原因：不预选任何选项（activeOptionIndex 初始 -1），用户未按键导航时
    // 点 Submit 提交空答案，表示明确跳过该问题。
    expect(onRespond).toHaveBeenLastCalledWith("ask-primary-submit", "accept", {
      answers: {},
    });
  });

  it("计划审批主提交保留自定义反馈而不改写成批准", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const onRespond = vi.fn();

    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, {
          request: createPlanApprovalRequest("plan-feedback-submit"),
          onRespond,
        }),
      );
    });
    act(() => changeCustomAnswer(container, "先补测试再实施"));
    act(() => clickPrimaryAction(container));

    expect(onRespond).toHaveBeenCalledWith("plan-feedback-submit", "accept", {
      answers: { "Review this implementation plan.": "先补测试再实施" },
      answer_0: "先补测试再实施",
      answer: "先补测试再实施",
    });
  });

  it("does not snooze on mount or auto focus, but snoozes once when the panel is hovered", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const onFirstInteraction = vi.fn(() => true);

    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, {
          request: createRequest("request-hover"),
          onFirstInteraction,
          onRespond: vi.fn(),
        }),
      );
    });
    expect(onFirstInteraction).not.toHaveBeenCalled();

    const card = findByAttribute(container, "data-elicitation-dialog-card", "true");
    expect(card).toBeDefined();
    act(() => {
      card?.dispatchEvent({ bubbles: true, type: "mouseover" });
      card?.dispatchEvent({ bubbles: true, type: "mouseover" });
    });
    act(() => clickFirstOption(container));

    expect(onFirstInteraction).toHaveBeenCalledTimes(1);
    expect(onFirstInteraction).toHaveBeenCalledWith("panelHover");
  });

  it("clicking the final-minute seconds snoozes without submitting an answer", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(940_001);
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const onFirstInteraction = vi.fn(() => true);
    const onRespond = vi.fn();

    try {
      act(() => {
        mountedRoot?.render(
          createElement(ElicitationDialog, {
            request: createRequest("request-countdown"),
            autoResolution: {
              state: "visibleCountdown",
              startedAt: 700_000,
              visibleAt: 760_000,
              deadlineAt: 1_000_000,
            },
            onFirstInteraction,
            onRespond,
          }),
        );
      });
      const countdown = findByAttribute(container, "data-elicitation-countdown-seconds", "59");
      expect(countdown).toBeDefined();
      act(() => countdown?.dispatchEvent({ bubbles: true, button: 0, type: "click" }));

      expect(onFirstInteraction).toHaveBeenCalledTimes(1);
      expect(onFirstInteraction).toHaveBeenCalledWith("countdown");
      expect(onRespond).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("reports an option selection as an answer interaction", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const onFirstInteraction = vi.fn(() => true);

    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, {
          request: createRequest("request-answer"),
          onFirstInteraction,
          onRespond: vi.fn(),
        }),
      );
    });
    act(() => clickFirstOption(container));

    expect(onFirstInteraction).toHaveBeenCalledTimes(1);
    expect(onFirstInteraction).toHaveBeenCalledWith("answer");
  });

  it("reports question paging as a navigation interaction", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const onFirstInteraction = vi.fn(() => true);

    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, {
          request: createRequest("request-navigation"),
          onFirstInteraction,
          onRespond: vi.fn(),
        }),
      );
    });
    const next = findByAttribute(container, "aria-label", "chat.elicitation.nextQuestion");
    expect(next).toBeDefined();
    act(() => next?.dispatchEvent({ bubbles: true, button: 0, type: "click" }));

    expect(onFirstInteraction).toHaveBeenCalledTimes(1);
    expect(onFirstInteraction).toHaveBeenCalledWith("navigation");
  });

  it("reports custom input changes as an answer interaction", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const onFirstInteraction = vi.fn(() => true);

    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, {
          request: createRequest("request-custom-answer"),
          onFirstInteraction,
          onRespond: vi.fn(),
        }),
      );
    });
    act(() => changeCustomAnswer(container, "自定义方案"));

    expect(onFirstInteraction).toHaveBeenCalledTimes(1);
    expect(onFirstInteraction).toHaveBeenCalledWith("answer");
  });

  it("allows a later interaction to retry when the snooze command fails", async () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const onFirstInteraction = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);

    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, {
          request: createRequest("request-retry"),
          onFirstInteraction,
          onRespond: vi.fn(),
        }),
      );
    });
    await act(async () => {
      clickFirstOption(container);
      await Promise.resolve();
    });
    act(() => clickFirstOption(container));

    expect(onFirstInteraction).toHaveBeenCalledTimes(2);
    expect(onFirstInteraction).toHaveBeenNthCalledWith(1, "answer");
    expect(onFirstInteraction).toHaveBeenNthCalledWith(2, "answer");
  });

  it("keeps the current question and drafts when the same request is reprojected", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const onRespond = vi.fn();
    const request = createRequest("request-1");

    act(() => {
      mountedRoot?.render(createElement(ElicitationDialog, { request, onRespond }));
    });
    act(() => clickFirstOption(container));

    // 模拟 autoResolution hiddenGrace -> snoozed 后，同一 interaction 被投影成新对象。
    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, {
          request: { ...request },
          onRespond,
        }),
      );
    });
    act(() => clickFirstOption(container));

    expect(onRespond).toHaveBeenCalledWith("request-1", "accept", {
      answers: {
        请选择保障项: "tests",
        请选择方案: "fast",
      },
      answer_0: "fast",
      answer_1: "tests",
    });
  });

  it("creates a fresh local form when requestId changes", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const onRespond = vi.fn();

    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, {
          request: createRequest("request-1"),
          onRespond,
        }),
      );
    });
    act(() => clickFirstOption(container));
    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, {
          request: createRequest("request-2"),
          onRespond,
        }),
      );
    });
    act(() => clickFirstOption(container));

    expect(onRespond).not.toHaveBeenCalled();
  });

  it("restores the current question and answers after the dialog is remounted", () => {
    const container = installMinimalDom();
    mountedRoot = createRoot(container);
    const onRespond = vi.fn();
    const request = createRequest("request-restored");
    const initialFormDraft = {
      questionIndex: 1,
      drafts: {
        "0:请选择方案": { selectedValues: ["fast"], customAnswer: "" },
        "1:请选择保障项": { selectedValues: [], customAnswer: "" },
      },
    };

    act(() => {
      mountedRoot?.render(
        createElement(ElicitationDialog, { request, initialFormDraft, onRespond }),
      );
    });
    act(() => clickFirstOption(container));

    expect(onRespond).toHaveBeenCalledWith("request-restored", "accept", {
      answers: {
        请选择保障项: "tests",
        请选择方案: "fast",
      },
      answer_0: "fast",
      answer_1: "tests",
    });
  });
});
