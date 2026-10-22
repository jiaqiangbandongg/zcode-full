import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  SOURCE_SERVER_REMOTE_RELEASE_TARGETS,
  beginSourceServerRemoteReleaseGeneration,
  collectSourceServerRemoteReleaseArchives,
} from "../src/packaging/remoteAssetRelease.js";

describe("Source Server remote release assets", () => {
  it("invalidates the previous descriptor before a new staging generation starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-generation-"));
    const versionReleaseDir = join(root, "releases", "3.8.0");
    const descriptorPath = join(versionReleaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
    await mkdir(versionReleaseDir, { recursive: true });
    await writeFile(descriptorPath, "stale-generation");

    await beginSourceServerRemoteReleaseGeneration({ versionReleaseDir });

    await expect(access(descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when any POSIX Source Server archive is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-missing-"));
    const distReleaseDir = join(root, "dist-release");
    await mkdir(distReleaseDir, { recursive: true });
    await writeFile(join(distReleaseDir, "zcode-server-linux-x64.tar.gz"), "linux-x64");
    const versionReleaseDir = join(root, "releases", "3.8.0");
    await mkdir(versionReleaseDir, { recursive: true });
    const descriptorPath = join(versionReleaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
    await writeFile(descriptorPath, "stale-generation");

    await expect(
      collectSourceServerRemoteReleaseArchives({
        distReleaseDir,
        versionReleaseDir,
        version: "3.8.0",
      }),
    ).rejects.toThrow(/missing Source Server remote release archive.*linux-arm64/i);
    await expect(access(descriptorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies exactly four POSIX archives into the version release root", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-complete-"));
    const distReleaseDir = join(root, "dist-release");
    const versionReleaseDir = join(root, "releases", "3.8.0");
    await mkdir(distReleaseDir, { recursive: true });
    for (const target of SOURCE_SERVER_REMOTE_RELEASE_TARGETS) {
      await writeFile(join(distReleaseDir, `zcode-server-${target}.tar.gz`), target);
    }

    const collected = await collectSourceServerRemoteReleaseArchives({
      distReleaseDir,
      versionReleaseDir,
      version: "3.8.0",
    });

    expect(collected.map((path) => path.split("/").at(-1))).toEqual(
      SOURCE_SERVER_REMOTE_RELEASE_TARGETS.map((target) => `zcode-server-${target}.tar.gz`),
    );
    await expect(
      Promise.all(collected.map(async (path) => await readFile(path, "utf8"))),
    ).resolves.toEqual(SOURCE_SERVER_REMOTE_RELEASE_TARGETS);

    const descriptor = JSON.parse(
      await readFile(join(versionReleaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME), "utf8"),
    ) as {
      schemaVersion: number;
      version: string;
      archives: Array<{
        target: string;
        version: string;
        fileName: string;
        sha256: string;
        sizeBytes: number;
        urls: string[];
      }>;
    };
    expect(descriptor).toMatchObject({ schemaVersion: 1, version: "3.8.0" });
    expect(descriptor.archives).toHaveLength(4);
    expect(descriptor.archives[0]).toEqual({
      target: "linux-x64",
      version: "3.8.0",
      fileName: "zcode-server-linux-x64.tar.gz",
      sha256: "2cc29203eb8483cf10595a15013d5b2e6305a1472b38c933ef0cbaaa27989735",
      sizeBytes: 9,
      urls: ["zcode-server-linux-x64.tar.gz"],
    });
  });

  it("publishes only the requested Linux archives and removes stale descriptor targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-linux-"));
    try {
      const distReleaseDir = join(root, "dist-release");
      const versionReleaseDir = join(root, "releases", "3.8.0");
      await mkdir(distReleaseDir, { recursive: true });
      for (const target of SOURCE_SERVER_REMOTE_RELEASE_TARGETS) {
        await writeFile(join(distReleaseDir, `zcode-server-${target}.tar.gz`), target);
      }
      await collectSourceServerRemoteReleaseArchives({
        distReleaseDir,
        versionReleaseDir,
        version: "3.8.0",
      });
      const targets = ["linux-x64", "linux-arm64"] as const;
      for (const target of targets) {
        await writeFile(join(distReleaseDir, `zcode-server-${target}.tar.gz`), `new-${target}`);
      }
      // macOS 源包缺失也必须能发布 Linux，且旧发布目录的 macOS 条目不能混入新 descriptor。
      for (const target of ["darwin-x64", "darwin-arm64"]) {
        await rm(join(distReleaseDir, `zcode-server-${target}.tar.gz`));
      }
      const collected = await collectSourceServerRemoteReleaseArchives({
        distReleaseDir,
        versionReleaseDir,
        version: "3.8.0",
        targets,
      });
      expect(collected).toEqual(
        targets.map((target) => join(versionReleaseDir, `zcode-server-${target}.tar.gz`)),
      );
      expect(await Promise.all(collected.map((path) => readFile(path, "utf8")))).toEqual(
        targets.map((target) => `new-${target}`),
      );
      const descriptor = JSON.parse(
        await readFile(join(versionReleaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME), "utf8"),
      );
      expect(descriptor.archives.map((archive: { target: string }) => archive.target)).toEqual(
        targets,
      );
      expect(descriptor.archives[0]).toMatchObject({
        sizeBytes: 13,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      await rm(join(distReleaseDir, "zcode-server-linux-arm64.tar.gz"));
      await expect(
        collectSourceServerRemoteReleaseArchives({
          distReleaseDir,
          versionReleaseDir,
          version: "3.8.0",
          targets,
        }),
      ).rejects.toThrow(/missing.*linux-arm64/i);
      await expect(
        access(join(versionReleaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
