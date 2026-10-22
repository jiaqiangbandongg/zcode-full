import { mkdtemp, writeFile, readFile, link, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceServerReleaseDescriptor } from "@zcode/shared";
import {
  selectSourceServerReleaseArchive,
  withSourceServerReleaseFileFault,
} from "#e2e/helpers/source-server-release-faults";

const descriptor: SourceServerReleaseDescriptor = {
  schemaVersion: 1,
  version: "3.12.0",
  archives: (["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const).map((target) => ({
    target,
    version: "3.12.0",
    fileName: `${target}-custom.tar.gz`,
    sha256: "a".repeat(64),
    sizeBytes: 10,
    urls: [`${target}-custom.tar.gz`],
  })),
};

describe("Source Server E2E release faults", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each([
    ["Linux", "aarch64", "linux-arm64"],
    ["Linux", "x86_64", "linux-x64"],
    ["Darwin", "arm64", "darwin-arm64"],
    ["Darwin", "x86_64", "darwin-x64"],
  ])("selects the actual %s/%s target instead of a fixed x64 archive", (platform, arch, target) => {
    expect(selectSourceServerReleaseArchive(descriptor, { platform, arch })).toEqual(
      descriptor.archives.find((entry) => entry.target === target),
    );
  });

  it("rejects missing or ambiguous targets instead of falling back to another archive", () => {
    expect(() =>
      selectSourceServerReleaseArchive(descriptor, { platform: "Linux", arch: "riscv64" }),
    ).toThrow("linux-riscv64");
    expect(() =>
      selectSourceServerReleaseArchive(
        { ...descriptor, archives: [...descriptor.archives, descriptor.archives[1]!] },
        { platform: "Linux", arch: "aarch64" },
      ),
    ).toThrow("linux-arm64");
  });

  it.each([null, "tampered"])(
    "restores %s faults after a failed assertion without modifying the hardlink source",
    async (replacement) => {
      const root = await mkdtemp(join(tmpdir(), "r3-release-fault-"));
      roots.push(root);
      const original = join(root, "original.tar.gz");
      const staged = join(root, "staged.tar.gz");
      await writeFile(original, "original");
      await link(original, staged);
      const failure = new Error("assertion failed");
      await expect(
        withSourceServerReleaseFileFault(staged, replacement, async () => {
          if (replacement === null)
            await expect(readFile(staged)).rejects.toMatchObject({ code: "ENOENT" });
          else expect(await readFile(staged, "utf8")).toBe(replacement);
          expect(await readFile(original, "utf8")).toBe("original");
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await readFile(staged, "utf8")).toBe("original");
      expect(await readFile(original, "utf8")).toBe("original");
      expect((await readdir(root)).sort()).toEqual(["original.tar.gz", "staged.tar.gz"]);
    },
  );
});
