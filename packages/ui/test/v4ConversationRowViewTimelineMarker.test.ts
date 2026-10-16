// @vitest-environment jsdom

import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { TimelineMarkerRow } from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

const modelSelectionMock = vi.hoisted(() => ({ view: null as ModelSelectionView | null }));

const context: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

function currentContext(): ConversationRowRenderContext {
  return { ...context, modelSelectionView: modelSelectionMock.view };
}

function renderMarker(row: TimelineMarkerRow, locale: "en-US" | "zh-CN" = "zh-CN"): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(ConversationRowView, { context: currentContext(), row }),
    ),
  );
}

afterEach(() => {
  modelSelectionMock.view = null;
});

function replaceProviders(providers: readonly { providerId: string; label: string }[]): void {
  modelSelectionMock.view = {
    revision: 1,
    providers: providers.map((provider) => ({
      providerId: provider.providerId,
      providerName: provider.label,
      config: {},
      models: [],
    })),
  } satisfies ModelSelectionView;
}

describe("ConversationRowView timeline marker contract", () => {
  it("exposes compact type, status, and origin without using localized text as authority", () => {
    const html = renderMarker({
      rowId: 12,
      turnId: "turn-1",
      createdAt: 1_700_000_000_000,
      createdAtSeq: 1,
      kind: "timelineMarker",
      sourceCommandId: "command-compact-1",
      marker: {
        type: "compact",
        status: "success",
        origin: "manual",
        operationId: "compact-1",
      },
    });

    expect(html).toContain('data-row-kind="timelineMarker"');
    expect(html).toContain('data-marker-type="compact"');
    expect(html).toContain('data-status="success"');
    expect(html).toContain('data-origin="manual"');
    expect(html).toContain('data-source-command-id="command-compact-1"');
  });

  it("不同供应商的同名模型使用供应商名称展示完整切换身份", () => {
    replaceProviders([
      { providerId: "primary-provider", label: "Primary Coding Plan" },
      { providerId: "alternate-provider", label: "Alternate API" },
    ]);

    const html = renderMarker({
      rowId: 13,
      turnId: "turn-2",
      createdAt: 1_700_000_001_000,
      createdAtSeq: 2,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: "primary-provider",
        fromModel: "glm-5.2",
        toProvider: "alternate-provider",
        toModel: "glm-5.2",
        toThought: "high",
      },
    });

    expect(html).toContain("模型已切换 Primary Coding Plan/glm-5.2 → Alternate API/glm-5.2");
    expect(html).toContain("lucide-arrow-right-left");
  });

  it("source 缺失的初始模型事实渲染为正在使用实际模型", () => {
    replaceProviders([{ providerId: "child-provider", label: "Child Provider" }]);

    const row: TimelineMarkerRow = {
      rowId: 17,
      turnId: "turn-child-1",
      createdAt: 1_700_000_005_000,
      createdAtSeq: 6,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        toProvider: "child-provider",
        toModel: "child-model",
        toThought: "high",
      },
    };
    const html = renderMarker(row);
    const englishHtml = renderMarker(row, "en-US");

    expect(html).toContain("正在使用 Child Provider/child-model");
    expect(html).not.toContain("正在使用 Child Provider/child-model 模型");
    expect(html).not.toContain("模型已切换");
    expect(html).not.toContain("lucide-arrow-right-left");
    expect(englishHtml).toContain("Using Child Provider/child-model");
    expect(englishHtml).not.toContain("Using Child Provider/child-model model");
  });

  it("账号套餐模型显示套餐类型，自定义供应商保留名称", () => {
    replaceProviders([
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        label: "Z.ai - Coding Plan",
      },
      {
        providerId: "custom:provider-b",
        label: "Provider B",
      },
    ]);

    const html = renderMarker({
      rowId: 16,
      turnId: "turn-5",
      createdAt: 1_700_000_004_000,
      createdAtSeq: 5,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        fromModel: "GLM-5.2",
        toProvider: "custom:provider-b",
        toModel: "model-b-4.5",
        toThought: "high",
      },
    });

    expect(html).toContain("模型已切换 GLM-5.2(个人套餐) → Provider B/model-b-4.5");
  });

  it.each([
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan, "个人套餐", "Individual Plan"],
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan, "体验套餐", "Start Plan"],
    [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan, "团队套餐", "Team Plan"],
    [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan, "个人套餐", "Individual Plan"],
    [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan, "体验套餐", "Start Plan"],
    [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan, "团队套餐", "Team Plan"],
  ])("目录缺失时仍按记录的 %s 展示套餐，支持中英文和首次使用", (providerId, zh, en) => {
    const row: TimelineMarkerRow = {
      rowId: 18,
      turnId: "turn-plan",
      createdAt: 1_700_000_006_000,
      createdAtSeq: 7,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: providerId,
        fromModel: "GLM-5.3",
        toProvider: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
        toModel: "GLM-5.3",
      },
    };
    expect(renderMarker(row)).toContain(`模型已切换 GLM-5.3(${zh}) → GLM-5.3(体验套餐)`);
    expect(renderMarker(row, "en-US")).toContain(`GLM-5.3(${en}) → GLM-5.3(Start Plan)`);
    row.marker = { type: "modelChange", toProvider: providerId, toModel: "GLM-5.3" };
    expect(renderMarker(row)).toContain(`正在使用 GLM-5.3(${zh})`);
  });

  it("供应商配置缺失时回落 provider ID 以保留同名模型身份", () => {
    const html = renderMarker({
      rowId: 14,
      turnId: "turn-3",
      createdAt: 1_700_000_002_000,
      createdAtSeq: 3,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: "removed-provider",
        fromModel: "glm-5.2",
        toProvider: "current-provider",
        toModel: "glm-5.2",
        toThought: "high",
      },
    });

    expect(html).toContain("模型已切换 removed-provider/glm-5.2 → current-provider/glm-5.2");
  });

  it("供应商目录稍后水合时原地刷新已渲染 marker 名称", () => {
    const row: TimelineMarkerRow = {
      rowId: 15,
      turnId: "turn-4",
      createdAt: 1_700_000_003_000,
      createdAtSeq: 4,
      kind: "timelineMarker",
      marker: {
        type: "modelChange",
        fromProvider: "primary-provider",
        fromModel: "glm-5.2",
        toProvider: "alternate-provider",
        toModel: "glm-5.2",
        toThought: "high",
      },
    };
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationRowView, { context: currentContext(), row }),
      ),
    );
    expect(view.container.textContent).toContain(
      "模型已切换 primary-provider/glm-5.2 → alternate-provider/glm-5.2",
    );

    act(() => {
      replaceProviders([
        { providerId: "primary-provider", label: "Primary Coding Plan" },
        { providerId: "alternate-provider", label: "Alternate API" },
      ]);
      view.rerender(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationRowView, { context: currentContext(), row: { ...row } }),
        ),
      );
    });

    expect(view.container.textContent).toContain(
      "模型已切换 Primary Coding Plan/glm-5.2 → Alternate API/glm-5.2",
    );
    view.unmount();
  });
});
