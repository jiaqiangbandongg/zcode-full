// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { $getPromptMarkdown } from "@/mentions/promptSerialization.js";
import { $createParagraphNode, $getRoot, createEditor } from "lexical";
import { normalizePromptMentionDisplayLabel } from "../src/mentions/promptMentionLabel.js";
import {
  $createPromptMentionNode,
  PromptMentionNode,
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
