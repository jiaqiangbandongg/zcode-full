import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const editViewSource = await readFile(
  new URL("../src/settings/AutomationEditView.tsx", import.meta.url),
  "utf8",
);

describe("automation schedule input height", () => {
  it("keeps every schedule state at 36px without wrapping added tags", () => {
    const readOnlyStart = editViewSource.indexOf(
      "{preserveSessionCreatedSchedule ? (",
    );
    const addScheduleStart = editViewSource.indexOf(
      "{scheduleRemoved ? (",
      readOnlyStart,
    );
    const selectedScheduleStart = editViewSource.indexOf(
      "调度栏原先使用 min-height",
      addScheduleStart,
    );
    const selectedScheduleEnd = editViewSource.indexOf(
      "<CustomRepeatDialog",
      selectedScheduleStart,
    );

    expect(readOnlyStart).toBeGreaterThanOrEqual(0);
    expect(addScheduleStart).toBeGreaterThan(readOnlyStart);
    expect(selectedScheduleStart).toBeGreaterThan(addScheduleStart);
    expect(selectedScheduleEnd).toBeGreaterThan(selectedScheduleStart);

    const readOnlySource = editViewSource.slice(
      readOnlyStart,
      addScheduleStart,
    );
    const addScheduleSource = editViewSource.slice(
      addScheduleStart,
      selectedScheduleStart,
    );
    const selectedScheduleSource = editViewSource.slice(
      selectedScheduleStart,
      selectedScheduleEnd,
    );

    expect(readOnlySource).toContain(
      "relative flex h-9 items-center overflow-hidden",
    );
    expect(addScheduleSource).toContain("flex h-9 w-full items-center");
    expect(selectedScheduleSource).toContain(
      "relative flex h-9 flex-nowrap items-center",
    );
    expect(selectedScheduleSource).toContain(
      "rounded-xl border border-input-border bg-input py-1 pl-[7px]",
    );
    expect(selectedScheduleSource).toContain(
      "h-auto min-w-24 rounded-full border-0 bg-hover py-px",
    );
    expect(selectedScheduleSource).toContain(
      "inline-flex h-auto items-center gap-0.5 rounded-full bg-hover py-px",
    );
    expect(selectedScheduleSource).not.toContain("bg-[#363636]");
    expect(selectedScheduleSource).not.toContain("bg-[#404040]");
    expect(selectedScheduleSource).not.toContain("h-5");
    expect(selectedScheduleSource).not.toContain("h-7");
    expect(selectedScheduleSource).not.toContain("rounded-md");
    expect(selectedScheduleSource).not.toContain("rounded-[8px]");
    expect(selectedScheduleSource).toContain("overflow-hidden");
    expect(selectedScheduleSource).toContain(
      "min-w-0 flex-1 truncate text-ui-base",
    );
    expect(selectedScheduleSource).not.toContain("min-h-9");
    expect(selectedScheduleSource).not.toContain("flex-wrap");
    expect(selectedScheduleSource).not.toContain("basis-full");
  });

  it("Task title 与所有 Schedule 状态使用全局 Input 描边", () => {
    expect(editViewSource).toContain(
      '"h-9 rounded-xl bg-input px-3 text-foreground"',
    );
    expect(editViewSource).not.toContain(
      "rounded-lg border-transparent bg-card px-2",
    );
    expect(editViewSource).toContain(
      "relative flex h-9 items-center overflow-hidden rounded-xl border border-input-border bg-input",
    );
    expect(editViewSource).toContain(
      'validationErrors.has("schedule")',
    );
    expect(editViewSource).toContain(
      ': "border-input-border"',
    );
    expect(editViewSource).toContain(
      "hover:border-input-border-hover",
    );
    expect(editViewSource).toContain(
      "focus-within:border-input-border-focused",
    );
  });
});
