// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { $getPromptMarkdown } from "@/mentions/promptSerialization.js";
import { $createParagraphNode, $getRoot, createEditor } from "lexical";
import { normalizePromptMentionDisplayLabel } from "../src/mentions/promptMentionLabel.js";
import {
  $createPromptMentionNode,
  GOAL_COMMAND_MENTION_ICON_NODE,
  GOAL_COMMAND_MENTION_LUCIDE_ICON_NAME,
  WORKFLOW_COMMAND_MENTION_ICON_NODE,
  WORKFLOW_COMMAND_MENTION_LUCIDE_ICON_NAME,
  PLUGIN_MENTION_ICON_NODE,
  PLUGIN_MENTION_LUCIDE_ICON_NAME,
  PromptMentionNode,
  SUBAGENT_MENTION_ICON_NODE,
  SUBAGENT_MENTION_LUCIDE_ICON_NAME,
} from "../src/mentions/nodes/PromptMentionNode.js";

describe("PromptMentionNode", () => {
  async function renderPluginMention(icon: string) {
    const editor = createEditor({ nodes: [PromptMentionNode] });
    const rootElement = document.createElement("div");
    editor.setRootElement(rootElement);
    await new Promise<void>((resolve) => {
      editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append(
              $createPromptMentionNode({
                id: "plugin:demo@mkt",
                category: "plugins",
                label: "Demo",
                value: "demo@mkt",
                markdown: "[@Demo](plugin://demo@mkt)",
                data: { pluginId: "demo@mkt", icon },
              }),
            ),
          );
        },
        { onUpdate: resolve },
      );
    });
    return { editor, rootElement };
  }

  it("keeps native selection offsets aligned with the visible label", async () => {
    const { editor, rootElement } = await renderPluginMention("https://cdn.example.com/demo.png");
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe("Demo");
    expect(rootElement.querySelector("[data-mention-id]")?.firstChild?.nodeType).toBe(
      Node.TEXT_NODE,
    );
  });

  it("renders a trusted original Plugin icon and keeps canonical text content", async () => {
    const { editor, rootElement } = await renderPluginMention("https://cdn.example.com/demo.png");

    expect(
      rootElement
        .querySelector<HTMLElement>("[data-mention-id]")
        ?.style.getPropertyValue("--mention-image"),
    ).toContain("https://cdn.example.com/demo.png");
    expect(rootElement.querySelector("img,svg")).toBeNull();
    expect(rootElement.textContent).toBe("Demo");
    expect(editor.getEditorState().read(() => $getPromptMarkdown())).toBe(
      "[@Demo](plugin://demo@mkt)",
    );
  });

  it("rejects an untrusted Plugin icon URL and falls back to Cable", async () => {
    const { rootElement } = await renderPluginMention("http://cdn.example.com/demo.png");

    expect(rootElement.querySelector("img")).toBeNull();
    expect(
      rootElement
        .querySelector<HTMLElement>("[data-mention-id]")
        ?.style.getPropertyValue("--mention-mask"),
    ).toContain("data:image/svg+xml");
    expect(rootElement.textContent).toBe("Demo");
  });

  it("keeps the text node and native selection when an icon fails asynchronously", async () => {
    const images: HTMLImageElement[] = [];
    const NativeImage = Image;
    vi.stubGlobal(
      "Image",
      class extends NativeImage {
        constructor() {
          super();
          images.push(this);
        }
      },
    );
    try {
      const { rootElement } = await renderPluginMention("https://cdn.example.com/fail.png");
      const chip = rootElement.querySelector<HTMLElement>("[data-mention-id]")!;
      const text = chip.firstChild;
      document.body.append(rootElement);
      const selection = window.getSelection()!;
      selection.selectAllChildren(chip);
      images[0]?.dispatchEvent(new Event("error"));
      expect(selection.toString()).toBe("Demo");
      expect(selection.isCollapsed).toBe(false);
      rootElement.remove();
      expect(chip.firstChild).toBe(text);
      expect(chip.textContent).toBe("Demo");
      expect(chip.style.getPropertyValue("--mention-mask")).toContain("data:image/svg+xml");
      expect(chip.style.getPropertyValue("--mention-image")).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the lucide Cable icon node for Plugin fallbacks", () => {
    expect(PLUGIN_MENTION_LUCIDE_ICON_NAME).toBe("Cable");
    expect(PLUGIN_MENTION_ICON_NODE).toEqual([
      ["path", { d: "M17 19a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1z" }],
      ["path", { d: "M17 21v-2" }],
      ["path", { d: "M19 14V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V10" }],
      ["path", { d: "M21 21v-2" }],
      ["path", { d: "M3 5V3" }],
      ["path", { d: "M4 10a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2z" }],
      ["path", { d: "M7 5V3" }],
    ]);
  });

  it("uses the lucide Goal icon node for the goal command mention icon", () => {
    expect(GOAL_COMMAND_MENTION_LUCIDE_ICON_NAME).toBe("Goal");
    expect(GOAL_COMMAND_MENTION_ICON_NODE).toEqual([
      ["path", { d: "M12 13V2l8 4-8 4" }],
      ["path", { d: "M20.561 10.222a9 9 0 1 1-12.55-5.29" }],
      ["path", { d: "M8.002 9.997a5 5 0 1 0 8.9 2.02" }],
    ]);
  });

  it("uses the lucide Workflow icon node for the workflow command mention icon", () => {
    expect(WORKFLOW_COMMAND_MENTION_LUCIDE_ICON_NAME).toBe("Workflow");
    expect(WORKFLOW_COMMAND_MENTION_ICON_NODE).toEqual([
      ["rect", { width: "8", height: "8", x: "3", y: "3", rx: "2" }],
      ["path", { d: "M7 11v4a2 2 0 0 0 2 2h4" }],
      ["rect", { width: "8", height: "8", x: "13", y: "13", rx: "2" }],
    ]);
  });

  it("uses the lucide Bot icon node for subagent mentions", () => {
    expect(SUBAGENT_MENTION_LUCIDE_ICON_NAME).toBe("Bot");
    expect(SUBAGENT_MENTION_ICON_NODE).toEqual([
      ["path", { d: "M12 8V4H8" }],
      ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
      ["path", { d: "M2 14h2" }],
      ["path", { d: "M20 14h2" }],
      ["path", { d: "M15 13v2" }],
      ["path", { d: "M9 13v2" }],
    ]);
  });

  it("normalizes markdown labels before rendering mention tags", () => {
    expect(
      normalizePromptMentionDisplayLabel(
        "skills",
        "[$find-skills](/Users/dev/.claude/skills/find-skills/SKILL.md)",
        "find-skills",
      ),
    ).toBe("find-skills");
    expect(
      normalizePromptMentionDisplayLabel(
        "sessions",
        "[#Review mailbox flow](#sess_visible_target)",
        "sess_visible_target",
      ),
    ).toBe("Review mailbox flow");
    expect(normalizePromptMentionDisplayLabel("skills", "code-review", "code-review")).toBe(
      "code-review",
    );
  });
});
