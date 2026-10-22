import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCODE_VERSION } from "@zcode/shared";
import { resolveSourceServerReleaseAsset } from "../src/host/sourceServerReleaseResolver.js";

const target = { kind: "ssh", host: "example.com", username: "alice" } as const;
const probe = { platform: "linux", arch: "x64", installed: false } as const;
const fileName = "zcode-server-linux-x64.tar.gz";

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function descriptor(contents: string) {
  return {
    schemaVersion: 1,
    version: ZCODE_VERSION,
    archives: [
      {
        target: "linux-x64",
        version: ZCODE_VERSION,
        fileName,
        sha256: sha256(contents),
        sizeBytes: Buffer.byteLength(contents),
        urls: [fileName],
      },
    ],
  };
}

describe("Source Server release resolver", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("previews descriptor metadata without downloading the archive", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("source-server-release.json"))
        return new Response(JSON.stringify(descriptor("preview-package")));
      throw new Error("preview must not fetch archives");
    });
    const release = await resolveSourceServerReleaseAsset(
      probe,
      { remoteCdnBaseUrl: "https://release.test" },
      target,
      { fetch },
      { metadataOnly: true },
    );
    expect(release).toMatchObject({ version: ZCODE_VERSION, sizeBytes: 15 });
    expect(release.localArchivePath).toBeUndefined();
    expect(
      fetch.mock.calls.every(([url]) => String(url).endsWith("source-server-release.json")),
    ).toBe(true);
  });
  it("uses and verifies a staged local archive for local-download-upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-local-"));
    const releaseDir = join(root, "releases", ZCODE_VERSION);
    const contents = "local-source-server";
    await mkdir(releaseDir, { recursive: true });
    await writeFile(join(releaseDir, fileName), contents);
    await writeFile(
      join(releaseDir, "source-server-release.json"),
      JSON.stringify(descriptor(contents)),
    );

    const release = await resolveSourceServerReleaseAsset(probe, { mockCdnDir: root }, target);

    expect(release).toMatchObject({
      localArchivePath: join(releaseDir, fileName),
      target: "linux-x64",
      version: ZCODE_VERSION,
      sha256: sha256(contents),
      sizeBytes: Buffer.byteLength(contents),
    });
  });

  it("uses the staged local archive for development even when SSH prefers remote download", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-dev-local-"));
    const releaseDir = join(root, "releases", ZCODE_VERSION);
    const contents = "development-source-server";
    await mkdir(releaseDir, { recursive: true });
    await writeFile(join(releaseDir, fileName), contents);
    await writeFile(
      join(releaseDir, "source-server-release.json"),
      JSON.stringify(descriptor(contents)),
    );
    const fetchMock = vi.fn(async () => {
      throw new Error("development resolution must not access CDN");
    });
    vi.stubGlobal("fetch", fetchMock);

    const release = await resolveSourceServerReleaseAsset(
      probe,
      {
        mockCdnDir: root,
        sourceServerArtifactPolicy: "development-content-addressed",
      },
      { ...target, assetInstallMode: "remote-download" },
    );

    expect(release.localArchivePath).toBe(join(releaseDir, fileName));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed without a staged local development descriptor", async () => {
    const fetchMock = vi.fn(async () => new Response("production-release", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveSourceServerReleaseAsset(
        probe,
        {
          sourceServerArtifactPolicy: "development-content-addressed",
          remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
        },
        target,
      ),
    ).rejects.toThrow("run pnpm bootstrap:with-remote");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves descriptor URLs without downloading the archive for remote-download", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-remote-"));
    const contents = "remote-source-server";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.endsWith("/source-server-release.json")) return new Response(null, { status: 404 });
      return new Response(JSON.stringify(descriptor(contents)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const release = await resolveSourceServerReleaseAsset(
      probe,
      {
        remoteCdnBaseUrls: [`https://cdn.example.test/releases/${ZCODE_VERSION}`],
        remoteCacheDir: root,
      },
      { ...target, assetInstallMode: "remote-download" },
    );

    expect(release).toEqual({
      target: "linux-x64",
      version: ZCODE_VERSION,
      sha256: sha256(contents),
      sizeBytes: Buffer.byteLength(contents),
      urls: [`https://cdn.example.test/releases/${ZCODE_VERSION}/${fileName}`],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads and verifies the descriptor archive into the Desktop cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-cache-"));
    const contents = "cached-source-server";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/source-server-release.json")) {
        return new Response(JSON.stringify(descriptor(contents)), { status: 200 });
      }
      if (url.endsWith(`/${fileName}`)) return new Response(contents, { status: 200 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const release = await resolveSourceServerReleaseAsset(
      probe,
      {
        remoteCdnBaseUrls: [`https://cdn.example.test/releases/${ZCODE_VERSION}`],
        remoteCacheDir: root,
      },
      target,
    );

    expect(release.localArchivePath).toBe(join(root, "source-server", ZCODE_VERSION, fileName));
    await expect(readFile(release.localArchivePath!, "utf8")).resolves.toBe(contents);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the injected remote asset network for descriptor and archive downloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-proxy-"));
    const contents = "proxy-source-server";
    const remoteAssetFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/source-server-release.json")) {
        return new Response(JSON.stringify(descriptor(contents)), { status: 200 });
      }
      if (url.endsWith(`/${fileName}`)) return new Response(contents, { status: 200 });
      return new Response(null, { status: 404 });
    });
    const directFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("remote asset direct fetch is forbidden"));
    vi.stubGlobal("fetch", directFetch);

    const release = await resolveSourceServerReleaseAsset(
      probe,
      {
        remoteCdnBaseUrls: [`https://cdn.example.test/releases/${ZCODE_VERSION}`],
        remoteCacheDir: root,
      },
      target,
      { fetch: remoteAssetFetch },
    );

    expect(release.localArchivePath).toBe(join(root, "source-server", ZCODE_VERSION, fileName));
    expect(remoteAssetFetch).toHaveBeenCalledTimes(2);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("does not fall back to direct fetch when the injected network fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-proxy-failure-"));
    const directFetch = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(descriptor("direct-source-server"))),
    );
    vi.stubGlobal("fetch", directFetch);
    const remoteAssetFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("proxy unavailable"));

    await expect(
      resolveSourceServerReleaseAsset(
        probe,
        {
          remoteCdnBaseUrls: [`https://cdn.example.test/releases/${ZCODE_VERSION}`],
          remoteCacheDir: root,
        },
        target,
        { fetch: remoteAssetFetch },
      ),
    ).rejects.toMatchObject({
      message: "Unable to resolve Source Server release descriptor",
      cause: expect.objectContaining({ message: "proxy unavailable" }),
    });
    expect(remoteAssetFetch).toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
  });
});
