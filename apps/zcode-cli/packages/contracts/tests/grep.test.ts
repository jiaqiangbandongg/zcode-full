import { describe, expect, it } from "vitest";
import { GrepErrorCode } from "../src/tools/grep.js";
import type { FileSystemErrorCode } from "../src/interfaces/file-system.port.js";

describe("Grep contracts", () => {
  it("declares stable cancelled error codes across grep and file system search", () => {
    const fileSystemCode: FileSystemErrorCode = "cancelled";

    expect(fileSystemCode).toBe("cancelled");
    expect(GrepErrorCode.CANCELLED).toBe("grep_cancelled");
  });
});
