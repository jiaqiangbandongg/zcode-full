import { describe, expect, it } from "vitest";
import { shouldRestorePersistedPaneSession } from "@/v4/usePaneSessionPersistence.js";

describe("pane last-session restore precedence", () => {
  it("restores only a cold workspace without an explicit draft intent", () => {
    expect(
      shouldRestorePersistedPaneSession({
        activeSessionId: null,
        draftFocusVersion: 0,
        enabled: true,
        rendererReload: true,
      }),
    ).toBe(true);
  });

  it("keeps an explicit draft instead of restoring the previous session", () => {
    expect(
      shouldRestorePersistedPaneSession({
        activeSessionId: null,
        draftFocusVersion: 1,
        enabled: true,
        rendererReload: true,
      }),
    ).toBe(false);
  });

  it("does not restore over an already selected session", () => {
    expect(
      shouldRestorePersistedPaneSession({
        activeSessionId: "session-current",
        draftFocusVersion: 0,
        enabled: true,
        rendererReload: true,
      }),
    ).toBe(false);
  });

  it("does not consume desktop persistence in web remote replayable mode", () => {
    expect(
      shouldRestorePersistedPaneSession({
        activeSessionId: null,
        draftFocusVersion: 0,
        enabled: false,
        rendererReload: true,
      }),
    ).toBe(false);
  });

  it("does not restore a persisted session on app cold launch or workspace entry", () => {
    expect(
      shouldRestorePersistedPaneSession({
        activeSessionId: null,
        draftFocusVersion: 0,
        enabled: true,
        rendererReload: false,
      }),
    ).toBe(false);
  });
});
