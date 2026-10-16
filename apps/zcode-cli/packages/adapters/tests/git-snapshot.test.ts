import { beforeEach, describe, expect, it, vi } from "vitest";

interface GitResponse {
  code: number;
  stdout?: string;
  stderr?: string;
}

interface GitCall {
  args: string[];
  command: string;
  options: {
    cwd?: string;
    maxBuffer?: number;
    timeout?: number;
    windowsHide?: boolean;
  };
}

const { execFileMock, gitCalls, resetGitMock, setGitResponse } = vi.hoisted(
  () => {
    const calls: GitCall[] = [];
    const responses = new Map<string, GitResponse>();
    const commandKey = (args: string[]) => args.join("\0");
    const runGitMock = (command: string, args: string[], options: GitCall["options"]) => {
      calls.push({ args: [...args], command, options });
      const response = responses.get(commandKey(args)) ?? { code: 1, stdout: "", stderr: "" };
      const stdout = response.stdout ?? "";
      const stderr = response.stderr ?? "";
      if (response.code === 0) {
        return { stdout, stderr };
      }

      const error = new Error(`git exited with ${response.code}`) as Error & {
        code?: number;
        stderr?: string;
        stdout?: string;
      };
      error.code = response.code;
      error.stdout = stdout;
      error.stderr = stderr;
      throw error;
    };
    const mock = vi.fn(
      (
        command: string,
        args: string[],
        options: GitCall["options"],
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        try {
          const result = runGitMock(command, args, options);
          callback(null, result.stdout, result.stderr);
        } catch (error) {
          const execError = error as Error & { stderr?: string; stdout?: string };
          callback(execError, execError.stdout ?? "", execError.stderr ?? "");
        }
      },
    );
    const customPromisify = Symbol.for("nodejs.util.promisify.custom");
    Object.defineProperty(mock, customPromisify, {
      value: (command: string, args: string[], options: GitCall["options"]) =>
        Promise.resolve().then(() => runGitMock(command, args, options)),
    });

    return {
      execFileMock: mock,
      gitCalls: calls,
      resetGitMock: () => {
        calls.length = 0;
        mock.mockClear();
        responses.clear();
      },
      setGitResponse: (args: string[], response: GitResponse) => {
        responses.set(commandKey(args), response);
      },
    };
  },
);

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("resolveGitSnapshot command semantics", () => {
  beforeEach(() => {
    resetGitMock();
  });

  it("keeps the local three second timeout for every git snapshot command", async () => {
    setGitResponse(["rev-parse", "--is-inside-work-tree"], { code: 0, stdout: "true\n" });
    setGitResponse(["rev-parse", "--abbrev-ref", "HEAD"], { code: 0, stdout: "feature\n" });
    setGitResponse(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      code: 0,
      stdout: "origin/main\n",
    });
    setGitResponse(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], {
      code: 0,
    });
    setGitResponse(["config", "user.name"], { code: 0, stdout: "ZCode Tester\n" });
    setGitResponse(["--no-optional-locks", "status", "--short"], {
      code: 0,
      stdout: " M tracked.txt\n",
    });
    setGitResponse(["--no-optional-locks", "log", "--oneline", "-n", "5"], {
      code: 0,
      stdout: "abc123 first commit\n",
    });

    const { resolveGitSnapshot } = await import("../src/context/git-snapshot.js");
    const snapshot = await resolveGitSnapshot("/workspace");

    expect(snapshot.isGitRepository).toBe(true);
    expect(gitCalls).not.toHaveLength(0);
    expect(gitCalls.every((call) => call.command === "git")).toBe(true);
    expect(gitCalls.every((call) => call.options.cwd === "/workspace")).toBe(true);
    expect(gitCalls.every((call) => call.options.maxBuffer === 1024 * 1024)).toBe(true);
    expect(gitCalls.every((call) => call.options.timeout === 3000)).toBe(true);
    expect(gitCalls.every((call) => call.options.windowsHide === true)).toBe(true);
  });

  it("drops stdout from failed optional git commands and keeps the snapshot usable", async () => {
    setGitResponse(["rev-parse", "--is-inside-work-tree"], { code: 0, stdout: "true\n" });
    setGitResponse(["rev-parse", "--abbrev-ref", "HEAD"], { code: 0, stdout: "feature\n" });
    setGitResponse(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      code: 1,
      stdout: "origin/should-not-leak\n",
    });
    setGitResponse(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], {
      code: 1,
    });
    setGitResponse(["show-ref", "--verify", "--quiet", "refs/remotes/origin/master"], {
      code: 1,
    });
    setGitResponse(["config", "user.name"], { code: 1, stdout: "Leaked User\n" });
    setGitResponse(["--no-optional-locks", "status", "--short"], {
      code: 128,
      stdout: " M leaked.txt\n",
    });
    setGitResponse(["--no-optional-locks", "log", "--oneline", "-n", "5"], {
      code: 128,
      stdout: "abc123 leaked commit\n",
    });

    const { resolveGitSnapshot } = await import("../src/context/git-snapshot.js");
    const snapshot = await resolveGitSnapshot("/workspace");

    expect(snapshot).toMatchObject({
      isGitRepository: true,
      gitBranch: "feature",
      gitMainBranch: "main",
      gitStatus: "clean",
      gitStatusLines: [],
      recentCommits: [],
    });
    expect(snapshot.gitUser).toBeUndefined();
  });
});
