import { describe, expect, it } from "vitest";

import { backgroundTaskOutputMetadata } from "../src/tool/executor/background-task-output.js";

describe("backgroundTaskOutputMetadata", () => {
  it("preserves the background subagent child session identity", () => {
    expect(
      backgroundTaskOutputMetadata(undefined, {
        childSessionId: "sess_child_launch",
      }).childSessionId,
    ).toBe("sess_child_launch");

    expect(
      backgroundTaskOutputMetadata(
        { childSessionId: "sess_child_snapshot" },
        { childSessionId: "sess_child_launch" },
      ).childSessionId,
    ).toBe("sess_child_snapshot");
  });

  it("falls back to stderr tail when stdout tail is empty", () => {
    const metadata = backgroundTaskOutputMetadata({
      result: {
        exitCode: 1,
        stderr: {
          bytes: 12,
          text: "stderr-only",
          truncated: false,
        },
        stdout: {
          bytes: 0,
          text: "",
          truncated: false,
        },
      },
    });

    expect(metadata.stdoutTail).toBeUndefined();
    expect(metadata.stderrTail).toBe("stderr-only");
    expect(metadata.outputTail).toBe("stderr-only");
  });
});
