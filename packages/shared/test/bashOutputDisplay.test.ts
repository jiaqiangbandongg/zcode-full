import { describe, expect, it } from "vitest";
import { zcodeSessionEventSchema } from "../src/zcode-protocol/index.js";
import { conversationRowSchema } from "../src/zcode-protocol-v4/index.js";

const display = {
  kind: "bash_output",
  output: "head",
  truncated: true,
  outputPath: "C:\\中文 空格\\output.log",
};
function parseBoth(value: unknown) {
  const event = {
    eventId: "bash-result-event",
    type: "tool.updated",
    sessionId: "session",
    seq: 1,
    timestamp: 1,
    payload: {
      kind: "result",
      toolCallId: "bash",
      toolName: "Bash",
      duration: 1,
      result: { success: true, content: "model preview", display: value },
    },
  };
  const row = {
    kind: "toolCall",
    rowId: 1,
    turnId: "turn",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: "bash",
    toolName: "Bash",
    inputText: "",
    status: "success",
    output: { text: "model preview", display: value },
  };
  return [zcodeSessionEventSchema.safeParse(event), conversationRowSchema.safeParse(row)];
}
describe("Bash output display wire contract", () => {
  it("preserves display on the legacy event and V4 row", () => {
    for (const parsed of parseBoth(display)) {
      expect(parsed.success).toBe(true);
      expect(JSON.stringify(parsed)).toContain(JSON.stringify(display));
    }
  });
  // 两条通道对"读不懂的 display"给出同一个产品结果——**这张卡没有载荷**——但拒收的位置不同，
  // 而位置决定代价：
  //   v3 `session/event`：整条事件被丢，consumer 记 zod issues 后继续（zcodeAgentService.ts）。
  //   v4 row：display 在信封层不设门（`.catch(undefined)`），载荷被丢、row/帧照常投影。
  // v4 曾经也在信封层拒收，但那一层的"拒"是拒整帧，会连带打掉订阅（见
  // zcodeProtocolV4DisplayTolerance.test.ts 的事故说明）。有界性没有放松：越界载荷同样到不了 UI。
  it.each([
    { ...display, output: "x".repeat(150001) },
    { ...display, truncated: "true" },
    { ...display, outputPath: "" },
    { ...display, unbounded: true },
  ])("两条通道都不携带越界/畸形 display", (invalid) => {
    const [event, row] = parseBoth(invalid);
    expect(event.success).toBe(false);
    expect(row.success).toBe(true);
    if (row.success && row.data.kind === "toolCall") {
      expect(row.data.output?.display).toBeUndefined();
    }
  });
});
