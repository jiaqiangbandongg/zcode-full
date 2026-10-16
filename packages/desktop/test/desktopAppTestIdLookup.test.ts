// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchMouseDownByExactTestId,
  readExactTestIdAttribute,
} from "./e2e/helpers/desktop-app.js";

afterEach(() => {
  document.body.replaceChildren();
});

describe("desktop e2e test id lookup", () => {
  it.each([
    ["macOS", "workspace-item-/Users/dev/Code/z-code/.e2e-home/ZCodeProject"],
    [
      "Windows",
      String.raw`workspace-item-C:\gitlab-runner\builds\project\packages\desktop\.e2e-home\ZCodeProject`,
    ],
  ])("matches the %s workspace path as an exact attribute value", (_platform, testId) => {
    const element = document.createElement("button");
    element.dataset.testid = testId;
    element.setAttribute("aria-expanded", "true");
    document.body.append(element);

    expect(readExactTestIdAttribute(testId, "data-testid")).toBe(testId);
    expect(readExactTestIdAttribute(testId, "aria-expanded")).toBe("true");
  });

  it("dispatches mousedown for a Windows skill option id", () => {
    const optionId = String.raw`skill:glm:workspace:C:\gitlab-runner\builds\project\.zcode\skills\demo\SKILL.md`;
    const testId = `prompt-suggestion-option-${optionId}`;
    const element = document.createElement("button");
    const onMouseDown = vi.fn();
    element.dataset.testid = testId;
    element.addEventListener("mousedown", onMouseDown);
    document.body.append(element);

    expect(dispatchMouseDownByExactTestId(testId)).toBe(true);
    expect(onMouseDown).toHaveBeenCalledOnce();
    expect(dispatchMouseDownByExactTestId(`${testId}-missing`)).toBe(false);
  });
});
