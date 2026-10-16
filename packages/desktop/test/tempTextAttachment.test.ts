import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "@zcode/services/node";
import { createTempTextAttachment } from "../src/main/tempTextAttachment.js";

let tempRoot: string | null = null;

afterEach(async () => {
  setDataBaseDir(null);
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("createTempTextAttachment", () => {
  it("writes pasted text under the zcode temp attachment directory", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-temp-text-"));
    setDataBaseDir(tempRoot);

    const result = await createTempTextAttachment({
      text: "hello pasted text",
      filename: "pasted-text-20260630-104512.txt",
    });

    expect(result.mimeType).toBe("text/plain");
    expect(result.filename).toMatch(/^pasted-text-20260630-104512-[a-f0-9-]+\.txt$/u);
    expect(result.localPath).toContain(join(tempRoot, ".zcode", "tmp", "paste-attachments"));
    await expect(readFile(result.localPath, "utf8")).resolves.toBe("hello pasted text");
    await expect(stat(result.localPath)).resolves.toMatchObject({
      size: Buffer.byteLength("hello pasted text", "utf8"),
    });
  });
});
