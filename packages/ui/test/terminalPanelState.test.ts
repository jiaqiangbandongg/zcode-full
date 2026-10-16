import { describe, expect, it } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import {
  closeTerminalSession,
  ensureWorkspaceTerminalState,
  exitTerminalSession,
  formatTerminalTabTitle,
  getNextTerminalSessionIndex,
  getTerminalSessionCloseAction,
  type TerminalPanelState,
  type TerminalSessionDescriptor,
} from "@/terminal/terminalPanelState.js";

const services = {} as IServiceAccessor;

function createSession(
  id: string,
  index: number,
  workspaceKey = "workspace",
): TerminalSessionDescriptor {
  return {
    id,
    workspaceKey,
    services,
    cwd: "/repo/z-code",
    index,
    shellLabel: null,
  };
}

function createState(
  sessions: TerminalSessionDescriptor[],
  activeSessionId = sessions[0]?.id ?? "",
): TerminalPanelState {
  return {
    sessions: Object.fromEntries(sessions.map((session) => [session.id, session])),
    workspaces: {
      workspace: {
        sessionIds: sessions.map((session) => session.id),
        activeSessionId,
      },
    },
  };
}

describe("terminalPanelState", () => {
  it("keeps the first title unnumbered and adds suffixes from two", () => {
    expect(formatTerminalTabTitle("z-code", 1)).toBe("z-code");
    expect(formatTerminalTabTitle("z-code", 2)).toBe("z-code 2");
    expect(formatTerminalTabTitle("Terminal", 3)).toBe("Terminal 3");
  });

  it("allocates the smallest available index without renaming existing sessions", () => {
    const first = createSession("terminal:1", 1);
    const second = createSession("terminal:2", 2);
    const third = createSession("terminal:3", 3);

    expect(getNextTerminalSessionIndex(createState([first]), "workspace")).toBe(2);
    expect(getNextTerminalSessionIndex(createState([first, third]), "workspace")).toBe(2);
    expect(getNextTerminalSessionIndex(createState([second]), "workspace")).toBe(1);

    const afterClosingSecond = closeTerminalSession(createState([first, second]), second.id);
    expect(getNextTerminalSessionIndex(afterClosingSecond, "workspace")).toBe(2);
    expect(afterClosingSecond.sessions[first.id]?.index).toBe(1);

    const afterClosingFirst = closeTerminalSession(createState([first, second]), first.id);
    expect(getNextTerminalSessionIndex(afterClosingFirst, "workspace")).toBe(1);
    expect(afterClosingFirst.sessions[second.id]?.index).toBe(2);
  });

  it("requests closing the panel without deleting the only session", () => {
    const state = createState([createSession("terminal:1", 1)]);

    expect(getTerminalSessionCloseAction(state, "terminal:1")).toBe("close-panel");
    expect(closeTerminalSession(state, "terminal:1")).toBe(state);
  });

  it("removes a selected session and activates its previous neighbor", () => {
    const first = createSession("terminal:1", 1);
    const second = createSession("terminal:2", 2);
    const third = createSession("terminal:3", 3);
    const state = createState([first, second, third], second.id);

    expect(getTerminalSessionCloseAction(state, second.id)).toBe("close-session");
    expect(closeTerminalSession(state, second.id)).toEqual({
      sessions: {
        [first.id]: first,
        [third.id]: third,
      },
      workspaces: {
        workspace: {
          sessionIds: [first.id, third.id],
          activeSessionId: first.id,
        },
      },
    });
  });

  it("auto closes an exited background session without changing the active session", () => {
    const first = createSession("terminal:1", 1);
    const second = createSession("terminal:2", 2);
    const state = createState([first, second], first.id);

    const result = exitTerminalSession(state, second.id, "workspace");

    expect(result.action).toBe("close-session");
    expect(result.state).toEqual({
      sessions: { [first.id]: first },
      workspaces: {
        workspace: {
          sessionIds: [first.id],
          activeSessionId: first.id,
        },
      },
    });
  });

  it("auto closes an exited active session and activates the previous neighbor", () => {
    const first = createSession("terminal:1", 1);
    const second = createSession("terminal:2", 2);
    const third = createSession("terminal:3", 3);
    const state = createState([first, second, third], second.id);

    const result = exitTerminalSession(state, second.id, "workspace");

    expect(result.action).toBe("close-session");
    expect(result.state.workspaces.workspace).toEqual({
      sessionIds: [first.id, third.id],
      activeSessionId: first.id,
    });
  });

  it("closes the panel after the active workspace's last session exits and recreates lazily", () => {
    const state = createState([createSession("terminal:1", 1)]);

    const result = exitTerminalSession(state, "terminal:1", "workspace");

    expect(result.action).toBe("close-panel");
    expect(result.state).toEqual({ sessions: {}, workspaces: {} });

    const recreated = ensureWorkspaceTerminalState(result.state, {
      workspaceKey: "workspace",
      services,
      cwd: "/repo/z-code",
    });
    const workspace = recreated.workspaces.workspace;
    expect(workspace?.sessionIds).toHaveLength(1);
    expect(recreated.sessions[workspace?.sessionIds[0] ?? ""]?.index).toBe(1);
  });

  it("does not close the active panel when a hidden workspace's last session exits", () => {
    const active = createSession("terminal:active", 1, "active-workspace");
    const hidden = createSession("terminal:hidden", 1, "hidden-workspace");
    const state: TerminalPanelState = {
      sessions: {
        [active.id]: active,
        [hidden.id]: hidden,
      },
      workspaces: {
        "active-workspace": {
          sessionIds: [active.id],
          activeSessionId: active.id,
        },
        "hidden-workspace": {
          sessionIds: [hidden.id],
          activeSessionId: hidden.id,
        },
      },
    };

    const result = exitTerminalSession(state, hidden.id, "active-workspace");

    expect(result.action).toBe("close-session");
    expect(result.state.sessions).toEqual({ [active.id]: active });
    expect(result.state.workspaces).toEqual({
      "active-workspace": {
        sessionIds: [active.id],
        activeSessionId: active.id,
      },
    });
  });
});
