import { describe, expect, it } from "vitest";
import { parseLocalConversationCommand } from "../src/lib/localConversationCommands.js";

describe("parseLocalConversationCommand", () => {
  it("识别完整的新会话命令", () => {
    expect(parseLocalConversationCommand("/new")).toBe("new");
    expect(parseLocalConversationCommand(" /clear ")).toBe("clear");
    expect(parseLocalConversationCommand("/NEW\t")).toBe("new");
  });

  it("不会截断带参数或其他 slash 命令", () => {
    expect(parseLocalConversationCommand("/clear cache")).toBeNull();
    expect(parseLocalConversationCommand("/goal clear")).toBeNull();
    expect(parseLocalConversationCommand("请执行 /new")).toBeNull();
    expect(parseLocalConversationCommand("/new-session")).toBeNull();
  });
});
