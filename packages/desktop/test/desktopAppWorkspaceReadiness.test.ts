// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  TID_COMPOSER_WORKSPACE_TRIGGER,
  TID_V4_SESSION_PANE,
  TID_WORKSPACE_ITEM,
  TID_WORKSPACE_PATH,
  testId,
} from "@zcode/shared";
import { probeWorkspaceAppState } from "./e2e/helpers/desktop-app.js";

const PROJECT_PATH = "/Users/dev/Code/z-code/.e2e-home/ZCodeProject";

function probe(expectedPath = PROJECT_PATH) {
  return probeWorkspaceAppState({
    workspacePathTestId: TID_WORKSPACE_PATH,
    workspaceItemTestId: testId(TID_WORKSPACE_ITEM, expectedPath),
    sessionPanePrefix: TID_V4_SESSION_PANE,
    composerWorkspaceTriggerTestId: TID_COMPOSER_WORKSPACE_TRIGGER,
    expectedPath,
  });
}

function appendTestId(testIdValue: string, attributes: Record<string, string> = {}) {
  const element = document.createElement("div");
  element.dataset.testid = testIdValue;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("desktop e2e workspace readiness probe", () => {
  it("reports the occupation onboarding page instead of waiting for a hidden workspace", () => {
    appendTestId("onboarding-page");

    expect(probe()).toBe("onboarding");
  });

  it("is ready when the workspace path badge matches", () => {
    appendTestId(TID_WORKSPACE_PATH, { title: PROJECT_PATH });

    expect(probe()).toBe("ready");
  });

  it("is ready when the sidebar workspace item and a v4 session pane both exist", () => {
    appendTestId(testId(TID_WORKSPACE_ITEM, PROJECT_PATH));
    appendTestId(`${TID_V4_SESSION_PANE}-pane-1`);

    expect(probe()).toBe("ready");
  });

  it("matches a Windows workspace item without CSS escaping the path", () => {
    const windowsPath = String.raw`C:\gitlab-runner\builds\project\packages\desktop\.e2e-home\ZCodeProject`;
    appendTestId(testId(TID_WORKSPACE_ITEM, windowsPath));
    appendTestId(`${TID_V4_SESSION_PANE}-pane-1`);

    expect(probe(windowsPath)).toBe("ready");
  });

  it("accepts the default conversation workspace through the composer trigger", () => {
    appendTestId(TID_COMPOSER_WORKSPACE_TRIGGER);
    appendTestId(`${TID_V4_SESSION_PANE}-pane-1`);

    expect(probe("/Users/dev/.zcode/workspace/default")).toBe("ready");
  });

  it("keeps waiting while neither the workspace nor onboarding is rendered", () => {
    appendTestId(testId(TID_WORKSPACE_ITEM, PROJECT_PATH));

    expect(probe()).toBe("pending");
  });
});
