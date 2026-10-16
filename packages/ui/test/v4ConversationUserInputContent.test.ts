// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ConversationUserInputContent,
  parseV4UserInputGoalQuery,
} from "@/v4/ConversationUserInputContent.js";
import { PluginReferenceIconProvider } from "@/v4/pluginReferenceIconContext.js";

function pluginContent(
  text: string,
  iconByPluginId: ReadonlyMap<string, string>,
) {
  return createElement(
    PluginReferenceIconProvider,
    { value: { sessionId: "session-a", iconByPluginId } },
    createElement(ConversationUserInputContent, { text }),
  );
}

describe("V4 user input goal query rendering", () => {
  it("splits an authoritative goal query without changing its original text", () => {
    expect(parseV4UserInputGoalQuery("  /goal 看一下这是个啥项目  ")).toEqual({
      leadingText: "  ",
      commandText: "/goal",
      trailingText: " 看一下这是个啥项目  ",
    });
    expect(parseV4UserInputGoalQuery("/TARGET replace 新目标")).toEqual({
      leadingText: "",
      commandText: "/TARGET",
      trailingText: " replace 新目标",
    });
  });

  it.each([
    ["普通正文提到 /goal 但不是命令", [], 0],
    ["/compact", [], 0],
    ["/goal 带文件", [{ ref: "artifact" }], 0],
    ["/goal 带上下文", [], 1],
  ] as const)("keeps non-goal-control input as plain text: %s", (text, attachments, count) => {
    expect(parseV4UserInputGoalQuery(text, attachments, count)).toBeNull();
  });

  it("renders the goal label without the slash while keeping its command semantics", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationUserInputContent, {
        text: "/goal 看一下这是个啥项目",
      }),
    );

    expect(html).toContain('data-v4-user-input-command="goal"');
    expect(html).toContain("lucide-goal");
    expect(html).toContain("text-command-node-foreground");
    expect(html).toContain("text-ui-base");
    expect(html).toContain("leading-6");
    expect(html).not.toContain("text-ui-lg");
    expect(html).not.toContain("leading-5");
    expect(html).toContain("goal</span> 看一下这是个啥项目");
    expect(html).not.toContain("/goal");
  });

  it("does not render a goal icon when attachments change the command into a normal prompt", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationUserInputContent, {
        attachments: [{ ref: "artifact" }],
        text: "/goal 只是普通正文",
      }),
    );

    expect(html).toBe("/goal 只是普通正文");
    expect(html).not.toContain("lucide-goal");
  });
});

describe("V4 user input mention rendering", () => {
  it("renders a trusted Session-authority Plugin icon without exposing the stable id", () => {
    const icon = "https://plugins.example.test/skill-creator.png";
    const html = renderToStaticMarkup(
      pluginContent(
        "使用 [@skill-creator](plugin://skill-creator@official)",
        new Map([["skill-creator@official", icon]]),
      ),
    );

    expect(html).toContain('data-plugin-mention-id="skill-creator@official"');
    expect(html).toContain('data-plugin-mention-icon="true"');
    expect(html).toContain(`src="${icon}"`);
    expect(html).toContain("skill-creator");
    expect(html).not.toContain("plugin://skill-creator@official");
    expect(html).not.toContain("lucide-cable");
  });

  it.each([
    ["missing", undefined],
    ["untrusted", "http://plugins.example.test/skill-creator.png"],
  ])("falls back to Cable for a %s Plugin icon", (_label, icon) => {
    const html = renderToStaticMarkup(
      pluginContent(
        "[@skill-creator](plugin://skill-creator@official)",
        icon
          ? new Map([["skill-creator@official", icon]])
          : new Map<string, string>(),
      ),
    );

    expect(html).toContain("lucide-cable");
    expect(html).not.toContain('data-plugin-mention-icon="true"');
  });

  it("falls back to Cable when the trusted Plugin image fails to load", () => {
    const view = render(
      pluginContent(
        "[@skill-creator](plugin://skill-creator@official)",
        new Map([
          [
            "skill-creator@official",
            "https://plugins.example.test/missing.png",
          ],
        ]),
      ),
    );
    const image = view.container.querySelector<HTMLImageElement>(
      "img[data-plugin-mention-icon='true']",
    );
    expect(image).not.toBeNull();

    fireEvent.error(image as HTMLImageElement);

    expect(
      view.container.querySelector("img[data-plugin-mention-icon='true']"),
    ).toBeNull();
    expect(view.container.querySelector(".lucide-cable")).not.toBeNull();
  });

  it("renders skill markdown as a structured label without exposing its path", () => {
    const skillPath =
      "/Users/dev/.zcode/cli/plugins/cache/zcode-plugins-official/cloudbase-skills/0.1.0/skills/cloudbase/references/ai-model-nodejs/SKILL.md";
    const html = renderToStaticMarkup(
      createElement(ConversationUserInputContent, {
        text: `[$ai-model-nodejs](${skillPath}) 111`,
      }),
    );

    expect(html).toContain("lucide-wand-sparkles");
    expect(html).toContain("text-skill-node-foreground");
    expect(html).toContain("Ai Model Nodejs");
    expect(html).toContain("111");
    expect(html).not.toContain("$ai-model-nodejs");
    expect(html).not.toContain(skillPath);
  });

  it("renders selected and legacy session mentions with conversation semantics", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationUserInputContent, {
        text: "跟 [#Review mailbox flow](#sess_visible_target) 聊，再看 #sess_legacy_target",
      }),
    );

    expect(html.match(/lucide-messages-square/g)).toHaveLength(2);
    expect(html.match(/text-session-node-foreground/g)).toHaveLength(2);
    expect(html).toContain("Review mailbox flow");
    expect(html).toContain("sess_legacy_target");
    expect(html).not.toContain("sess_visible_target");
  });

  it("renders files, directories, and subagents with their previous UI variants", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationUserInputContent, {
        text: "查看 [demo.ts](./src/demo.ts)、[components](./src/components/)，再交给 @reviewer",
      }),
    );

    expect(html.match(/text-file-node-foreground/g)).toHaveLength(2);
    expect(html).toContain("demo.ts");
    expect(html).toContain("components");
    expect(html).not.toContain("./src/demo.ts");
    expect(html).not.toContain("./src/components/");
    expect(html).toContain("lucide-bot");
    expect(html).toContain("text-subagent-node-foreground");
    expect(html).toContain("reviewer");
  });

  it("renders command-specific icons while omitting only the authoritative goal slash", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationUserInputContent, {
        text: "/goal 优化性能，之后 /compact 再 /review",
      }),
    );

    expect(html).toContain('data-v4-user-input-command="goal"');
    expect(html).not.toContain("/goal");
    expect(html).toContain("lucide-goal");
    expect(html).toContain("lucide-scroll-text");
    expect(html).toContain("lucide-square-slash");
    expect(html.match(/text-command-node-foreground/g)).toHaveLength(3);
  });

  it("does not treat arbitrary hash text or a non-authoritative goal prefix as mentions", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationUserInputContent, {
        attachments: [{ ref: "artifact" }],
        text: "/goal 普通正文里提到 #archived",
      }),
    );

    expect(html).toBe("/goal 普通正文里提到 #archived");
    expect(html).not.toContain("lucide-goal");
    expect(html).not.toContain("lucide-messages-square");
  });
});
