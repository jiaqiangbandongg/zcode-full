import { describe, expect, it } from "vitest";
import { GANTT_BAR_MIN_WIDTH_PX, ganttItemStyle } from "../src/gantt-style.js";

describe("Gantt item styling", () => {
  it("keeps range bars wide enough for very fast tool calls", () => {
    expect(GANTT_BAR_MIN_WIDTH_PX).toBe(18);
    expect(ganttItemStyle("range")).toBe("min-width: 18px;");
  });

  it("leaves point markers governed by vis-timeline defaults", () => {
    expect(ganttItemStyle("point")).toBeUndefined();
  });
});
