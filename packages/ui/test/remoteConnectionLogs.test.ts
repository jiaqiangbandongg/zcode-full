import { describe, expect, it } from "vitest";
import {
  appendRemoteConnectionRuntimeLog,
  normalizeRemoteConnectionLogMessage,
  shouldAcceptRemoteConnectionRuntimeLog,
  type RemoteConnectionLogEntry,
} from "@/hooks/useRemoteConnectionLogs.js";

function createLogEntry(overrides: Partial<RemoteConnectionLogEntry>): RemoteConnectionLogEntry {
  return {
    id: "log-1",
    level: "info",
    message: "connecting...",
    timestamp: "10:00:00",
    ...overrides,
  };
}

describe("remote connection log merge", () => {
  it("preserves Source Server phases while removing generic process prefixes", () => {
    expect(
      normalizeRemoteConnectionLogMessage(
        "[2026-08-19 12:00:00.000] [pid:123] [source-server:upload] upload progress (archive): 50.0%",
      ),
    ).toBe("[source-server:upload] upload progress (archive): 50.0%");
  });

  it("coalesces Source Server upload progress by phase and artifact", () => {
    const current = [
      createLogEntry({
        id: "source-upload",
        message: "[source-server:upload] upload progress (archive): 10.0%",
      }),
    ];
    const next = appendRemoteConnectionRuntimeLog(current, {
      id: "source-upload-next",
      level: "info",
      message: "[source-server:upload] upload progress (archive): 80.0%",
      timestamp: "10:00:09",
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.message).toContain("80.0%");
  });
  it("coalesces consecutive download progress lines into one row", () => {
    const currentLogs = [
      createLogEntry({
        id: "progress-1",
        message: "download progress: 15.0% (15.0/100.0 MB, 2.50 MB/s)",
      }),
    ];

    const nextLogs = appendRemoteConnectionRuntimeLog(currentLogs, {
      id: "progress-2",
      level: "info",
      message: "download progress: 20.0% (20.0/100.0 MB, 2.20 MB/s)",
      timestamp: "10:00:01",
    });

    expect(nextLogs).toHaveLength(1);
    expect(nextLogs[0]?.id).toBe("progress-1");
    expect(nextLogs[0]?.message).toContain("20.0%");
    expect(nextLogs[0]?.timestamp).toBe("10:00:01");
  });

  it("appends a new row when message is not a progress update", () => {
    const currentLogs = [
      createLogEntry({
        id: "progress-1",
        message: "download progress: 100.0% (100.0/100.0 MB, 3.10 MB/s)",
      }),
    ];

    const nextLogs = appendRemoteConnectionRuntimeLog(currentLogs, {
      id: "checksum-1",
      level: "info",
      message: "checksum verified",
      timestamp: "10:00:02",
    });

    expect(nextLogs).toHaveLength(2);
    expect(nextLogs[1]?.id).toBe("checksum-1");
    expect(nextLogs[1]?.message).toBe("checksum verified");
  });

  it("coalesces consecutive upload progress lines for the same file", () => {
    const currentLogs = [
      createLogEntry({
        id: "upload-1",
        message: "upload progress [exec] (node.new): 35.0% (3.5/10.0 MB, 2.40 MB/s)",
      }),
    ];

    const nextLogs = appendRemoteConnectionRuntimeLog(currentLogs, {
      id: "upload-2",
      level: "info",
      message: "upload progress [exec] (node.new): 55.0% (5.5/10.0 MB, 2.10 MB/s)",
      timestamp: "10:00:03",
    });

    expect(nextLogs).toHaveLength(1);
    expect(nextLogs[0]?.id).toBe("upload-1");
    expect(nextLogs[0]?.message).toContain("55.0%");
    expect(nextLogs[0]?.timestamp).toBe("10:00:03");
  });

  it("coalesces interleaved upload progress lines for the same file", () => {
    const currentLogs = [
      createLogEntry({
        id: "node-upload",
        message: "upload progress [sftp] (node.new): 20.0% (2.0/10.0 MB, 2.00 MB/s)",
      }),
      createLogEntry({
        id: "server-upload",
        message: "upload progress [sftp] (zcode-server.cjs.new): 45.0% (4.5/10.0 MB, 1.80 MB/s)",
      }),
    ];

    const nextLogs = appendRemoteConnectionRuntimeLog(currentLogs, {
      id: "node-upload-next",
      level: "info",
      message: "upload progress [sftp] (node.new): 25.0% (2.5/10.0 MB, 2.10 MB/s)",
      timestamp: "10:00:04",
    });

    expect(nextLogs).toHaveLength(2);
    expect(nextLogs[0]?.id).toBe("server-upload");
    expect(nextLogs[1]?.id).toBe("node-upload");
    expect(nextLogs[1]?.message).toContain("25.0%");
    expect(nextLogs[1]?.timestamp).toBe("10:00:04");
  });

  it("keeps separate rows for upload progress from different files", () => {
    const currentLogs = [
      createLogEntry({
        id: "upload-1",
        message: "upload progress [exec] (node.new): 100.0% (10.0/10.0 MB, 2.00 MB/s)",
      }),
    ];

    const nextLogs = appendRemoteConnectionRuntimeLog(currentLogs, {
      id: "upload-2",
      level: "info",
      message: "upload progress [exec] (zcode-server.cjs.new): 5.0% (0.5/10.0 MB, 1.50 MB/s)",
      timestamp: "10:00:04",
    });

    expect(nextLogs).toHaveLength(2);
    expect(nextLogs[1]?.id).toBe("upload-2");
    expect(nextLogs[1]?.message).toContain("zcode-server.cjs.new");
  });

  it("keeps separate rows for different upload transports of the same file", () => {
    const currentLogs = [
      createLogEntry({
        id: "upload-1",
        message: "upload progress [sftp] (node.new): 0.1% (0.1/10.0 MB, 0.37 MB/s)",
      }),
    ];

    const nextLogs = appendRemoteConnectionRuntimeLog(currentLogs, {
      id: "upload-2",
      level: "info",
      message: "upload progress [exec] (node.new): 5.0% (0.5/10.0 MB, 1.20 MB/s)",
      timestamp: "10:00:05",
    });

    expect(nextLogs).toHaveLength(2);
    expect(nextLogs[1]?.message).toContain("[exec]");
  });

  it("filters remote connection logs by active request id", () => {
    expect(shouldAcceptRemoteConnectionRuntimeLog({ requestId: "request-1" }, "request-1")).toBe(
      true,
    );
    expect(
      shouldAcceptRemoteConnectionRuntimeLog({ requestId: "background-request" }, "request-1"),
    ).toBe(false);
    expect(
      shouldAcceptRemoteConnectionRuntimeLog(
        { requestId: "background-request" },
        null,
      ),
    ).toBe(true);
  });
});

it("coalesces source archive progress while byte counts and speed change", () => {
  const first = createLogEntry({
    message: "[source-server:upload] upload progress: 10.0% (1.0/10.0 MB, 2.00 MB/s)",
  });
  const next = appendRemoteConnectionRuntimeLog([first], {
    ...first,
    id: "next",
    message: "[source-server:upload] upload progress: 90.0% (9.0/10.0 MB, 3.00 MB/s)",
  });
  expect(next).toHaveLength(1);
  expect(next[0]?.message).toContain("90.0%");
});
