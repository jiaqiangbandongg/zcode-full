import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("terminal session exit handoff", () => {
  it("forwards PTY exit codes to the bottom terminal tab registry", () => {
    const sessionSource = readSource("packages/ui/src/terminal/TerminalSession.tsx");
    const panelSource = readSource("packages/ui/src/Terminal.tsx");

    expect(sessionSource).toContain("onExit?: (sessionId: string, exitCode: number) => void");
    expect(sessionSource).toContain("exitHandler(sessionId, exitCode)");
    expect(sessionSource).toContain("term.write(`\\r\\n${exitedMessageRef.current}\\r\\n`)");
    expect(panelSource).toContain("exitTerminalSession(current, sessionId, workspaceKey)");
    expect(panelSource).toContain("onExit={handleSessionExit}");
  });
});
