import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFileSync(path, "utf8");

describe("assistant markdown type scale", () => {
  it("keeps the shared response typography on the compact markdown scale", () => {
    const messageSource = readSource(
      "packages/ui/src/components/ai-elements/message.tsx",
    );
    const codeBlockSource = readSource(
      "packages/ui/src/components/ai-elements/code-block.tsx",
    );
    const tableSource = readSource(
      "packages/ui/src/components/ai-elements/markdown-table.tsx",
    );
    const conversationRowSource = readSource(
      "packages/ui/src/v4/ConversationRowView.tsx",
    );
    const stylesSource = readSource("packages/ui/src/styles.css");
    // 用户输入气泡已拆到 ConversationUserInputBubble，排版断言随组件迁移。
    const userInputBubbleSource = readSource(
      "packages/ui/src/v4/ConversationUserInputBubble.tsx",
    );

    expect(messageSource).toContain("overflow-hidden text-ui-base");
    expect(messageSource).toContain(
      "wrap-anywhere text-ui-base font-medium text-icon-blue",
    );
    expect(messageSource).toContain(
      "text-icon-blue text-ui-base no-underline",
    );
    expect(messageSource).toContain('h1: "mt-6 mb-4 text-ui-xl font-semibold"');
    expect(messageSource).toContain('h2: "mt-6 mb-4 text-ui-lg font-semibold"');
    expect(messageSource).toContain('h3: "mt-6 mb-4 text-ui-base font-semibold"');
    expect(messageSource).toContain('h6: "mt-6 mb-4 text-ui-base font-normal"');
    expect(messageSource).toContain("size-full text-ui-base leading-[1.75]");
    expect(messageSource).toContain("font-mono text-ui-sm");
    expect(stylesSource).toContain(
      "--color-icon-blue: var(--color-terminal-bright-blue);",
    );
    expect(codeBlockSource).toContain("text-ui-base text-muted-foreground");
    expect(tableSource).toContain("border-separate border-spacing-0 text-ui-base");
    expect(conversationRowSource).toContain(
      'data-conversation-selectable="true" className="w-full text-ui-base"',
    );
    expect(conversationRowSource).toContain(
      "group/user-row flex flex-col items-end",
    );
    expect(userInputBubbleSource).toContain("px-4 py-3 text-ui-base text-foreground");
  });
});
