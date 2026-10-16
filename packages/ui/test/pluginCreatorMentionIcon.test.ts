// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginMentionOptionContent } from "@/mentions/components/PluginMentionOptionContent.js";
import { decoratePromptMention } from "@/mentions/nodes/promptMentionDecoration.js";
import { buildSessionPluginIconMap } from "@/v4/pluginReferenceIconProjection.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { PluginReferenceIconProvider } from "@/v4/pluginReferenceIconContext.js";

const pluginId = "plugin-creator@zcode-plugins-official";
const entry = {
  pluginId,
  name: "plugin-creator",
  marketplace: "zcode-plugins-official",
  enabled: true,
  conflictingPluginIds: [],
  skillQualifiedNames: [],
  mcpServerNames: [],
  subagentNames: [],
};

describe("official creator mention artwork", () => {
  it("uses bundled artwork in the picker without a remote listing icon", () => {
    const html = renderToStaticMarkup(
      createElement(PluginMentionOptionContent, {
        item: {
          id: `plugin:${pluginId}`,
          category: "plugins",
          label: "插件创建器",
          value: pluginId,
          data: { pluginId },
        },
      }),
    );
    expect(html).toContain("plugin-creator.png");
  });

  it("decorates the composer chip by stable identity without changing its text", () => {
    const dom = document.createElement("span");
    dom.textContent = "插件创建器";
    decoratePromptMention(dom, "plugins", pluginId);
    expect(dom.style.getPropertyValue("--mention-image")).toContain("plugin-creator.png");
    expect(dom.textContent).toBe("插件创建器");
    decoratePromptMention(dom, "plugins", "plugin-creator@personal", { icon: "/untrusted.png" });
    expect(dom.style.getPropertyValue("--mention-image")).toBe("");
    expect(dom.style.getPropertyValue("--mention-mask")).not.toBe("");
  });

  it("renders sent chips only after the matching entry is in Session authority", () => {
    const text = `[@插件创建器](plugin://${pluginId})`;
    const render = (authority: "session" | "workspace") =>
      renderToStaticMarkup(
        createElement(
          PluginReferenceIconProvider,
          {
            value: {
              sessionId: "session",
              iconByPluginId: buildSessionPluginIconMap(authority, [entry]),
            },
          },
          createElement(ConversationUserInputContent, { text }),
        ),
      );
    expect(render("session")).toContain("plugin-creator.png");
    expect(render("workspace")).not.toContain("plugin-creator.png");
    expect(buildSessionPluginIconMap("session", []).has(pluginId)).toBe(false);
  });
});
