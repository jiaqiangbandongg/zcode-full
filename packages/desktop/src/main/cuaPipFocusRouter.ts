import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";

type FocusEvent = Extract<PipSessionEvent, { kind: "focus-changed" }>;

export interface CuaPipFocusRouter {
  updateActiveSession(windowId: number, sessionId: string | null): void;
  focusWindow(windowId: number): void;
  blurWindow(windowId: number): void;
  refreshWindow(windowId: number): void;
  removeWindow(windowId: number): void;
}

export function resolveCuaPipWindowKey(window: {
  webContents: { id: number };
}): number {
  return window.webContents.id;
}

export function createCuaPipFocusRouter(options: {
  send(windowId: number, event: FocusEvent): void;
}): CuaPipFocusRouter {
  const activeSessionByWindow = new Map<number, string | null>();
  let focusedWindowId: number | null = null;
  let focusRevision = 0;

  const publish = (windowId: number, sessionId: string | null) => {
    focusRevision += 1;
    options.send(windowId, {
      kind: "focus-changed",
      revision: focusRevision,
      sourceWindowId: `window-${windowId}`,
      sessionId,
    });
  };

  return {
    updateActiveSession(windowId, sessionId) {
      if (activeSessionByWindow.get(windowId) === sessionId) return;
      activeSessionByWindow.set(windowId, sessionId);
      if (focusedWindowId === windowId) publish(windowId, sessionId);
    },
    focusWindow(windowId) {
      if (focusedWindowId === windowId) return;
      const previous = focusedWindowId;
      focusedWindowId = windowId;
      if (previous !== null) publish(previous, null);
      publish(windowId, activeSessionByWindow.get(windowId) ?? null);
    },
    blurWindow(windowId) {
      if (focusedWindowId !== windowId) return;
      focusedWindowId = null;
      publish(windowId, null);
    },
    refreshWindow(windowId) {
      if (focusedWindowId !== windowId) return;
      publish(windowId, activeSessionByWindow.get(windowId) ?? null);
    },
    removeWindow(windowId) {
      activeSessionByWindow.delete(windowId);
      if (focusedWindowId !== windowId) return;
      focusedWindowId = null;
      publish(windowId, null);
    },
  };
}
