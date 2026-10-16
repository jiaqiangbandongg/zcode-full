import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { QueueState } from "@zcode/shared/zcode-protocol-v4";
import {
  ConversationQueuePanel,
  resolveV4QueueReorderAnchor,
} from "@/v4/ConversationQueuePanel.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

function queueState(): QueueState {
  return {
    autoDrain: true,
    items: [
      {
        queueItemId: "q-1",
        kind: "sendText",
        text: "第一条问题",
        sourceCommandId: "cmd-1",
        clientId: "cli",
        attachments: [],
        delivery: { requested: "queue", admitted: "queue" },
        order: { admissionSeq: 1, queuePosition: 0 },
        steer: { state: "notRequested" },
        dispatch: { state: "queued" },
        admittedAt: 1,
      },
      {
        queueItemId: "q-2",
        kind: "sendText",
        text: "第二条问题",
        sourceCommandId: "cmd-2",
        clientId: "cli",
        attachments: [],
        delivery: { requested: "queue", admitted: "queue" },
        order: { admissionSeq: 2, queuePosition: 1 },
        steer: { state: "notRequested" },
        dispatch: { state: "queued" },
        admittedAt: 2,
      },
    ],
  };
}

function renderPanel(): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationQueuePanel, {
        queue: queueState(),
        onDeleteItem: vi.fn(),
        onEditItem: vi.fn(),
        onSendNow: vi.fn(),
        onMoveItem: vi.fn(),
      }),
    ),
  );
}

describe("ConversationQueuePanel", () => {
  it("shows queued attachment names alongside the sender", () => {
    const queue = queueState();
    queue.items[0]!.attachments = [
      { ref: "attachment:test", fileName: "requirements.pdf", mime: "application/pdf", bytes: 100 },
    ];
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationQueuePanel, { queue }),
      ),
    );
    expect(html).toContain("requirements.pdf");
  });

  it("renders v4 queue with icon actions and drag handles", () => {
    const html = renderPanel();

    expect(html).toContain('data-testid="v4-queue"');
    expect(html).toContain('data-queue-item-id="q-1"');
    expect(html).toContain('data-queue-item-id="q-2"');
    expect(html).toContain('data-v4-queue-drag-handle="true"');
    expect(html).toContain("backdrop-blur-md");
    expect(html).toContain(">立即<");
    expect(html).not.toContain(">立即发送<");
    expect(html).not.toContain(">上移<");
  });

  it("renders stop-specific paused banner and resume action", () => {
    const queue = { ...queueState(), autoDrain: false, pauseReason: "stopped" as const };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationQueuePanel, {
          queue,
          onResume: vi.fn(),
        }),
      ),
    );

    expect(html).toContain('data-testid="v4-queue-paused-banner"');
    expect(html).toContain("由于你中断了当前响应，队列已暂停");
    expect(html).toContain('data-testid="v4-queue-resume"');
    expect(html).toContain(">继续<");
  });

  it("uses authoritative dispatch to lock reserved/promoting item actions", () => {
    const queue = queueState();
    queue.items[0] = {
      ...queue.items[0]!,
      dispatch: { state: "reserved", reservationId: "send-now-1" },
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationQueuePanel, {
          queue,
          onDeleteItem: vi.fn(),
          onEditItem: vi.fn(),
          onSendNow: vi.fn(),
          onMoveItem: vi.fn(),
        }),
      ),
    );

    expect(html).toContain('data-dispatch-state="reserved"');
    expect(html).toContain('data-dispatch-state="queued"');
    expect(html).toContain("disabled");
  });

  it("queue edit 只触发撤回动作，并在 ACK 期间锁定目标行", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationQueuePanel, {
          queue: queueState(),
          onDeleteItem: vi.fn(),
          onEditItem: vi.fn(),
          onSendNow: vi.fn(),
          onMoveItem: vi.fn(),
          pendingEditQueueItemId: "q-1",
        }),
      ),
    );

    expect(html).toContain('data-edit-pending="true"');
    expect(html).toContain('data-edit-pending="false"');
    expect(html).not.toContain("v4-queue-item-edit-input");
  });

  it("renders compact as a maintenance item with the shared immediate label and no edit action", () => {
    const queue = queueState();
    queue.items = [
      {
        ...queue.items[0]!,
        queueItemId: "q-compact",
        kind: "compact",
        text: "/compact",
        attachments: [],
      },
    ];
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationQueuePanel, {
          queue,
          onDeleteItem: vi.fn(),
          onEditItem: vi.fn(),
          onSendNow: vi.fn(),
          onMoveItem: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("/compact");
    expect(html).toContain(">立即<");
    expect(html).not.toContain("立即执行");
    expect(html).not.toContain("lucide-minimize-2");
    expect(html).not.toContain('aria-label="编辑"');
  });

  it("converts drag targets into CLI beforeQueueItemId anchors", () => {
    const items = [
      ...queueState().items,
      {
        queueItemId: "q-3",
        kind: "sendText" as const,
        text: "第三条问题",
        sourceCommandId: "cmd-3",
        clientId: "cli",
        attachments: [],
        delivery: { requested: "queue" as const, admitted: "queue" as const },
        order: { admissionSeq: 3, queuePosition: 2 },
        steer: { state: "notRequested" as const },
        dispatch: { state: "queued" as const },
        admittedAt: 3,
      },
      {
        queueItemId: "q-4",
        kind: "sendText" as const,
        text: "第四条问题",
        sourceCommandId: "cmd-4",
        clientId: "cli",
        attachments: [],
        delivery: { requested: "queue" as const, admitted: "queue" as const },
        order: { admissionSeq: 4, queuePosition: 3 },
        steer: { state: "notRequested" as const },
        dispatch: { state: "queued" as const },
        admittedAt: 4,
      },
    ];

    expect(resolveV4QueueReorderAnchor(items, "q-3", "q-1")).toEqual({
      beforeQueueItemId: "q-1",
      queueItemId: "q-3",
    });
    expect(resolveV4QueueReorderAnchor(items, "q-1", "q-3")).toEqual({
      beforeQueueItemId: "q-4",
      queueItemId: "q-1",
    });
    expect(resolveV4QueueReorderAnchor(items, "q-1", "q-4")).toEqual({
      beforeQueueItemId: null,
      queueItemId: "q-1",
    });
    expect(resolveV4QueueReorderAnchor(items, "q-2", "q-2")).toBeNull();
    expect(resolveV4QueueReorderAnchor(items, "missing", "q-2")).toBeNull();
    expect(resolveV4QueueReorderAnchor(items, "q-2", "missing")).toBeNull();
  });
});

it("renders standard references without leaking the wire encoding into queue text", () => {
  const queue = queueState();
  queue.items[0]!.text =
    'Review\n\n# userselect:\n```userselect\n[{"text":"quoted original"}]\n```';
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ConversationQueuePanel, { queue }),
    ),
  );
  expect(html).toContain("data-conversation-selection-reference-count");
  expect(html).not.toContain("# userselect:");
});
