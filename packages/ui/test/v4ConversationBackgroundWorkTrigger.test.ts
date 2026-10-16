import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: string }) =>
    createElement("div", { "data-tooltip": title }, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }, values?: Record<string, string>) =>
        values
          ? `${descriptor.id} ${values.bashCount}/${values.workflowCount}/${values.subagentCount}/${values.count}`
          : descriptor.id,
    },
  }),
}));

function backgroundWork(overrides: Partial<BackgroundWorkSummary> = {}): BackgroundWorkSummary {
  return {
    workId: "work-1",
    kind: "bash",
    title: "Run checks",
    status: "running",
    startedAt: 1_700_000_000_000,
    anchorRowId: null,
    ...overrides,
  };
}

async function renderTrigger(
  backgroundWorks: readonly BackgroundWorkSummary[],
  runningSubagentCount = 0,
  onOpen: (() => void) | undefined = vi.fn(),
  openTarget?: "panel" | "workflow-run",
) {
  const { ConversationBackgroundWorkTrigger } =
    await import("@/v4/composer/ConversationBackgroundWorkTrigger.js");
  return renderToStaticMarkup(
    createElement(ConversationBackgroundWorkTrigger, {
      backgroundWorks,
      runningSubagentCount,
      onOpen,
      ...(openTarget ? { openTarget } : {}),
    }),
  );
}

describe("ConversationBackgroundWorkTrigger", () => {
  it("counts running Bash work and the authoritative running Agent projection", async () => {
    const { getComposerBackgroundWorkCounts } =
      await import("@/v4/composer/ConversationBackgroundWorkTrigger.js");
    const works = [
      backgroundWork(),
      backgroundWork({ workId: "bash-2" }),
      backgroundWork({ workId: "agent-1", kind: "subagent" }),
      backgroundWork({ workId: "pending", status: "resultPending" }),
      backgroundWork({ workId: "failed", status: "failed" }),
      backgroundWork({ workId: "cancelled", status: "cancelled" }),
    ];

    expect(getComposerBackgroundWorkCounts(works, 1)).toEqual({
      bashCount: 2,
      workflowCount: 0,
      subagentCount: 1,
      totalCount: 3,
    });
  });

  it("renders one accessible button with typed wide counts and a compact total", async () => {
    const html = await renderTrigger([backgroundWork()], 2);

    expect(html).toContain('data-testid="v4-composer-background-work-trigger"');
    expect(html).toContain('data-background-bash-count="1"');
    expect(html).toContain('data-background-workflow-count="0"');
    expect(html).toContain('data-background-subagent-count="2"');
    expect(html).toContain('data-background-total-count="3"');
    expect(html).toContain('data-composer-background-layout="typed"');
    expect(html).toContain("@max-[480px]/composer:hidden");
    expect(html).toContain('data-composer-background-layout="compact"');
    expect(html).toContain("@max-[480px]/composer:inline-flex");
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="chat.composer.backgroundWorks.ariaLabel 1/0/2/3"');
    expect(html).toContain('data-tooltip="chat.composer.backgroundWorks.tooltipMixed"');
  });

  it("uses a type-specific tooltip, omits zero segments, and hides after the last work", async () => {
    const bashOnly = await renderTrigger([
      backgroundWork(),
      backgroundWork({ workId: "agent-terminal", kind: "subagent", status: "failed" }),
    ]);
    expect(bashOnly).toContain('data-background-bash-count="1"');
    expect(bashOnly).toContain('data-background-subagent-count="0"');
    expect(bashOnly).not.toContain("lucide-bot");
    expect(bashOnly).toContain('data-tooltip="chat.composer.backgroundWorks.tooltipTerminal"');

    const agentOnly = await renderTrigger([], 1);
    expect(agentOnly).toContain('data-background-bash-count="0"');
    expect(agentOnly).not.toContain("lucide-square-terminal");
    expect(agentOnly).toContain('data-tooltip="chat.composer.backgroundWorks.tooltipAgent"');

    const terminalOnly = await renderTrigger([
      backgroundWork({ status: "resultPending" }),
      backgroundWork({ workId: "failed", kind: "subagent", status: "failed" }),
    ]);
    expect(terminalOnly).toBe("");
    expect(await renderTrigger([], 0, undefined)).toBe("");
  });
});

// workflow 从 bashCount 拆成自己的一类（docs/dynamic-workflow/presentation.md「Other places a run appears」item 6）。
// 拆分不能顺手把入口也拆掉：**只有 workflow 在跑时 badge 仍必须出现**，因为面板里才有停止
// 按钮（取消的三个入口之一）——这正是拆分前把它塞进 bashCount 所保住的那件事。
describe("getComposerBackgroundWorkCounts with dwf workflow runs", () => {
  it("counts running workflow runs as their own type instead of Bash", async () => {
    const { getComposerBackgroundWorkCounts } = await import(
      "@/v4/composer/ConversationBackgroundWorkTrigger.js"
    );

    expect(
      getComposerBackgroundWorkCounts(
        [
          backgroundWork({ workId: "bash-1", kind: "bash" }),
          backgroundWork({ workId: "dwfrun-1", kind: "workflow" }),
          backgroundWork({ workId: "dwfrun-2", kind: "workflow" }),
        ],
        1,
      ),
    ).toEqual({ bashCount: 1, workflowCount: 2, subagentCount: 1, totalCount: 4 });
  });

  it("ignores settled workflow runs", async () => {
    const { getComposerBackgroundWorkCounts } = await import(
      "@/v4/composer/ConversationBackgroundWorkTrigger.js"
    );

    expect(
      getComposerBackgroundWorkCounts([
        backgroundWork({ workId: "dwfrun-1", kind: "workflow", status: "failed" }),
        backgroundWork({ workId: "dwfrun-2", kind: "workflow", status: "resultPending" }),
      ]),
    ).toEqual({ bashCount: 0, workflowCount: 0, subagentCount: 0, totalCount: 0 });
  });

  it("keeps the badge and its own icon when only a workflow runs", async () => {
    const html = await renderTrigger([backgroundWork({ workId: "dwfrun-1", kind: "workflow" })]);

    expect(html).toContain('data-testid="v4-composer-background-work-trigger"');
    expect(html).toContain('data-background-workflow-count="1"');
    expect(html).toContain('data-background-bash-count="0"');
    expect(html).toContain('data-background-total-count="1"');
    expect(html).toContain("lucide-workflow");
    expect(html).not.toContain("lucide-square-terminal");
    expect(html).not.toContain("lucide-bot");
    expect(html).toContain('data-tooltip="chat.composer.backgroundWorks.tooltipWorkflow"');
    expect(html).toContain('aria-label="chat.composer.backgroundWorks.ariaLabel 0/1/0/1"');
  });

  it("falls back to the mixed tooltip once a second type joins the workflow", async () => {
    const html = await renderTrigger([
      backgroundWork({ workId: "dwfrun-1", kind: "workflow" }),
      backgroundWork({ workId: "bash-1", kind: "bash" }),
    ]);

    expect(html).toContain('data-tooltip="chat.composer.backgroundWorks.tooltipMixed"');
    expect(html).toContain("lucide-workflow");
    expect(html).toContain("lucide-square-terminal");
  });

  // 直达（docs/dynamic-workflow/presentation.md）：宿主判定唯一在跑的工作流可直开详情页时，
  // 徽标换 tooltip 并把落点暴露成结构化属性；缺省仍是展开胶囊。
  it("announces the direct run-details target when the host resolves one", async () => {
    const direct = await renderTrigger(
      [backgroundWork({ workId: "dwfrun-1", kind: "workflow" })],
      0,
      vi.fn(),
      "workflow-run",
    );
    expect(direct).toContain('data-background-open-target="workflow-run"');
    expect(direct).toContain('data-tooltip="chat.composer.backgroundWorks.tooltipWorkflowDetails"');
    expect(direct).toContain('data-background-workflow-count="1"');

    const panel = await renderTrigger([backgroundWork({ workId: "dwfrun-1", kind: "workflow" })]);
    expect(panel).toContain('data-background-open-target="panel"');
    expect(panel).toContain('data-tooltip="chat.composer.backgroundWorks.tooltipWorkflow"');
  });

  it("orders the typed segments terminal-first, then workflow, then agent", async () => {
    const html = await renderTrigger(
      [
        backgroundWork({ workId: "dwfrun-1", kind: "workflow" }),
        backgroundWork({ workId: "bash-1", kind: "bash" }),
      ],
      1,
    );
    const order = ["lucide-square-terminal", "lucide-workflow", "lucide-bot"].map((icon) =>
      html.indexOf(icon),
    );

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });
});
