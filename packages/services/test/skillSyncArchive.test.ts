import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_SYNC_SIZE_LIMIT_ERROR_CODE } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  createSkillSyncArchive,
  extractSkillSyncArchive,
} from "../src/skill-sync/skillSyncArchive.js";

async function tempDir() {
  return await mkdtemp(join(tmpdir(), "zcode-skill-sync-"));
}

describe("skill sync archive", () => {
  it("round-trips regular skill directories", async () => {
    const root = await tempDir();
    const skillDir = join(root, "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: review\n---\nbody");
    await writeFile(join(skillDir, "notes.txt"), "hello");

    const archive = await createSkillSyncArchive([
      { sourcePath: skillDir, archivePath: "review" },
    ]);
    const output = join(root, "out");
    await extractSkillSyncArchive(archive, output);

    await expect(readFile(join(output, "review", "SKILL.md"), "utf-8")).resolves.toContain(
      "name: review",
    );
    await expect(readdir(join(output, "review"))).resolves.toContain("notes.txt");
  });

  it("rejects path traversal entries", async () => {
    const root = await tempDir();
    const skillDir = join(root, "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: review\n---\nbody");

    await expect(
      createSkillSyncArchive([{ sourcePath: skillDir, archivePath: "../review" }]),
    ).rejects.toThrow("unsafe skill archive path");
  });

  it("reports a structured error when compressed output exceeds the content limit", async () => {
    const root = await tempDir();
    const skillDir = join(root, "large-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "a".repeat(400_000));

    const archive = await createSkillSyncArchive([
      { sourcePath: skillDir, archivePath: "large-skill" },
    ]);

    await expect(
      extractSkillSyncArchive(archive, join(root, "out"), { maxExtractedBytes: 1024 }),
    ).rejects.toMatchObject({
      code: SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
      data: {
        actualBytes: expect.any(Number),
        maxBytes: 1024,
        phase: "extracted-content",
      },
    });
  });

  it("accepts many tar entries when their file content stays within the limit", async () => {
    const root = await tempDir();
    const entries = [] as Array<{ sourcePath: string; archivePath: string }>;
    const fileCount = 300;

    for (let index = 0; index < fileCount; index += 1) {
      const skillDir = join(root, `skill-${index}`);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "content.txt"), "a");
      entries.push({ sourcePath: skillDir, archivePath: `skill-${index}` });
    }

    const archive = await createSkillSyncArchive(entries);
    const output = join(root, "out");

    await expect(
      extractSkillSyncArchive(archive, output, { maxExtractedBytes: fileCount }),
    ).resolves.toBeUndefined();
    await expect(readFile(join(output, "skill-299", "content.txt"), "utf-8")).resolves.toBe("a");
  });

  it("rejects archives with an invalid gzip trailer", async () => {
    const root = await tempDir();
    const skillDir = join(root, "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: review\n---\nbody");

    const archive = await createSkillSyncArchive([
      { sourcePath: skillDir, archivePath: "review" },
    ]);
    const corruptedArchive = Uint8Array.from(archive);
    corruptedArchive[corruptedArchive.length - 1] ^= 0xff;

    await expect(extractSkillSyncArchive(corruptedArchive, join(root, "out"))).rejects.toThrow();
  });
});
