import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  clearAutomationEditRequiredFieldError,
  resolveAutomationEditRequiredFieldErrors,
} from "@/settings/automationEditValidation.js";

const editViewSource = readFileSync(
  new URL("../src/settings/AutomationEditView.tsx", import.meta.url),
  "utf8",
);

describe("automation edit validation", () => {
  it("reports required fields in a stable visual order", () => {
    expect(
      resolveAutomationEditRequiredFieldErrors({
        title: " ",
        cronExpr: "",
        prompt: "\n",
      }),
    ).toEqual(["title", "schedule", "prompt"]);
  });

  it("normal field edits only clear existing validation feedback", () => {
    const errors = new Set(["title", "schedule", "prompt"] as const);

    expect(clearAutomationEditRequiredFieldError(errors, "schedule")).toEqual(
      new Set(["title", "prompt"]),
    );
    expect(clearAutomationEditRequiredFieldError(new Set(), "schedule")).toEqual(new Set());
  });

  it("does not reveal schedule validation from the delete interaction", () => {
    const handlerStart = editViewSource.indexOf("const handleRemoveSchedule = useCallback");
    const handlerEnd = editViewSource.indexOf("const isSessionCreatedAutomation", handlerStart);
    const handlerSource = editViewSource.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerSource).toContain('markFieldTouched("schedule")');
    expect(handlerSource).toContain('clearRequiredFieldValidation("schedule")');
    expect(handlerSource).toContain("setScheduleRemoved(true)");
    expect(handlerSource).not.toContain("setScheduleInvalid(true)");
    expect(editViewSource.match(/onClick=\{handleRemoveSchedule\}/g)).toHaveLength(2);
  });

  it("reveals required field feedback only from save and run-now attempts", () => {
    expect(editViewSource).toContain('validationSource: "save"');
    expect(editViewSource).toContain('validationSource: "run-now"');
    expect(editViewSource).toMatch(
      /aria-invalid=\{\s*validationErrors\.has\("title"\) && !title\.trim\(\)\s*\}/,
    );
    expect(editViewSource).toMatch(
      /invalid=\{\s*validationErrors\.has\("prompt"\) && !prompt\.trim\(\)\s*\}/,
    );
    expect(editViewSource).toMatch(
      /aria-invalid=\{\s*validationErrors\.has\("prompt"\) && !prompt\.trim\(\)\s*\}/,
    );
    expect(editViewSource).not.toContain("setScheduleInvalid(true)");
  });

  it("keeps edit save and run-now clickable when only required fields are missing", () => {
    const actionsStart = editViewSource.indexOf("{showEditingSettingsActions ?");
    const actionsEnd = editViewSource.indexOf("<DropdownMenu>", actionsStart);
    const actionsSource = editViewSource.slice(actionsStart, actionsEnd);

    expect(actionsStart).toBeGreaterThanOrEqual(0);
    expect(actionsSource).toContain("disabled={!submissionContextReady || saving}");
    expect(actionsSource).toContain("!submissionContextReady ||");
    expect(actionsSource).not.toContain("!canSubmit");
  });

  it("不再保留 inherit/default model 虚拟态", () => {
    expect(editViewSource).not.toContain("INHERIT_MODEL_VALUE");
    expect(editViewSource).not.toContain("automations.form.model.inherit");
  });
});
