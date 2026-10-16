import type { ClientSceneConfig, ClientSceneItem } from "@zcode/services";
import { describe, expect, it } from "vitest";
import {
  mapClientScenesToDraftSuggestedPromptItems,
  resolveDraftSuggestedPromptText,
} from "@/v4/draftSuggestedPromptItems.js";

function createItem(
  overrides: Partial<ClientSceneItem> & Pick<ClientSceneItem, "id">,
): ClientSceneItem {
  return {
    id: overrides.id,
    type: overrides.type ?? "prompt",
    contents: overrides.contents ?? { cn: "中文 prompt", en: "English prompt" },
    descs: overrides.descs ?? { cn: "", en: "" },
    labels: overrides.labels ?? { cn: "中文标签", en: "English label" },
    on_finish: overrides.on_finish ?? null,
    img: overrides.img ?? null,
    share_urls: overrides.share_urls ?? {},
    ...overrides,
  };
}

function createScene(promptItems: ClientSceneItem[]): ClientSceneConfig {
  return {
    namespace: "zcode",
    scene: "draft-suggestion",
    options: {
      prompts: {
        id: "prompt",
        type: "prompt",
        contents: { cn: "提示词", en: "Prompt" },
        prompts: { cn: "", en: "" },
        items: promptItems,
        refer: "",
        cascades: {},
      },
      plugin: {
        id: "plugin",
        type: "plugin",
        contents: { cn: "插件", en: "Plugin" },
        prompts: { cn: "", en: "" },
        items: [
          createItem({
            id: "document-skills",
            type: "plugin",
            contents: {
              cn: "document-skills@zcode-plugins-official",
              en: "document-skills@zcode-plugins-official",
            },
            labels: { cn: "文档技能", en: "Document skills" },
          }),
        ],
        refer: "",
        cascades: {},
      },
    },
    created_at: 1,
    updated_at: 2,
  };
}

describe("draft suggested prompt Client Scenes mapping", () => {
  it("maps draft-suggestion prompt items and reverses defaults into one Plugin reference", () => {
    const prompt = createItem({
      id: "create-pdf",
      img: "file-text",
      imgs: {
        cn: "https://cdn.example.com/create-pdf-cn.svg",
        en: "https://cdn.example.com/create-pdf-en.svg",
      },
      contents: {
        cn: "根据工作区制作 PDF",
        en: "Create a PDF from the workspace",
      },
      labels: { cn: "制作 PDF", en: "Create PDF" },
      defaults: { plugin: ["document-skills"] },
    });

    expect(
      mapClientScenesToDraftSuggestedPromptItems([
        { ...createScene([]), scene: "ai-slides" },
        createScene([prompt]),
      ]),
    ).toEqual([
      {
        id: "create-pdf",
        iconName: "file-text",
        label: { cn: "制作 PDF", en: "Create PDF" },
        prompt: {
          cn: "根据工作区制作 PDF",
          en: "Create a PDF from the workspace",
        },
        plugin: {
          stableId: "document-skills@zcode-plugins-official",
          label: { cn: "文档技能", en: "Document skills" },
        },
      },
    ]);
  });

  it("maps the Lucide icon name only from img and ignores localized imgs", () => {
    const withoutImg = createItem({
      id: "without-img",
      img: null,
      imgs: {
        cn: "https://cdn.example.com/ignored-cn.svg",
        en: "https://cdn.example.com/ignored-en.svg",
      },
    });

    expect(mapClientScenesToDraftSuggestedPromptItems([createScene([withoutImg])])).toEqual([
      {
        id: "without-img",
        label: withoutImg.labels,
        prompt: withoutImg.contents,
      },
    ]);
  });

  it("splits, trims, deduplicates, and allowlists on_finish actions", () => {
    const navigationPrompt = createItem({
      id: "open-automations",
      on_finish:
        " UNKNOWN:ACTION, NAVIGATE:AUTOMATIONS, NAVIGATE:AUTOMATIONS:OFFPEAK, NAVIGATE:AUTOMATIONS , NAVIGATE:AUTOMATIONS:OFFPEAK ",
    });

    expect(mapClientScenesToDraftSuggestedPromptItems([createScene([navigationPrompt])])).toEqual([
      {
        id: "open-automations",
        label: navigationPrompt.labels,
        prompt: navigationPrompt.contents,
        actions: ["NAVIGATE:AUTOMATIONS", "NAVIGATE:AUTOMATIONS:OFFPEAK"],
      },
    ]);
  });

  it("keeps a prompt without Plugin when defaults cannot be resolved", () => {
    const prompt = createItem({
      id: "plain",
      defaults: { missingOption: ["missing-item"], plugin: ["also-missing"] },
    });

    expect(mapClientScenesToDraftSuggestedPromptItems([createScene([prompt])])).toEqual([
      {
        id: "plain",
        label: prompt.labels,
        prompt: prompt.contents,
      },
    ]);
  });

  it("returns no recommendations without draft-suggestion.options.prompts", () => {
    expect(mapClientScenesToDraftSuggestedPromptItems([])).toEqual([]);
    expect(
      mapClientScenesToDraftSuggestedPromptItems([{ ...createScene([]), scene: "ai-writing" }]),
    ).toEqual([]);
    expect(
      mapClientScenesToDraftSuggestedPromptItems([
        { ...createScene([]), options: {}, scene: "draft-suggestion" },
      ]),
    ).toEqual([]);
  });

  it("resolves cn/en directly and falls back to the other available language", () => {
    expect(resolveDraftSuggestedPromptText({ cn: "中文", en: "English" }, "zh-CN")).toBe("中文");
    expect(resolveDraftSuggestedPromptText({ cn: "中文", en: "English" }, "en-US")).toBe("English");
    expect(resolveDraftSuggestedPromptText({ cn: "中文", en: "" }, "en-US")).toBe("中文");
  });
});
