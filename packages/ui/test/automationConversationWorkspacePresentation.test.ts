import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../src/settings/AutomationEditView.tsx", import.meta.url),
  "utf8",
);

describe("AutomationEditView 无项目会话展示契约", () => {
  it("保留 conversation 语义并复用会话侧固定菜单项", () => {
    expect(source).toContain("workspacePurpose: option.workspacePurpose");
    expect(source).toContain("allowConversationWorkspaceSelection");
    expect(source).toContain("allowConversationWorkspaceDetach={false}");
    expect(source).toContain(
      "onSelectConversationWorkspace={handleSelectConversationWorkspace}",
    );
  });
});
