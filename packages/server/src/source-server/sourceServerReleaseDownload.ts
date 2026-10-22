import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import { buildRemoteArtifactDownloadCommand } from "@zcode/server/remote/remoteAssetInstaller.js";
import { detectRemoteAssetTools } from "@zcode/server/remote/remoteAssetPreflight.js";
import type { ServerReleaseAsset } from "@zcode/server/source-server/transportAdapter.js";

export async function buildSourceServerReleaseDownloadCommand(options: {
  backend: IRemoteBackend;
  release: ServerReleaseAsset;
  remoteArchive: string;
  onLog?: (message: string) => void;
}): Promise<string> {
  if (options.release.urls.length === 0) {
    throw new Error("Source Server release has no remote download URL");
  }
  const tools = await detectRemoteAssetTools(options.backend, {
    log: (message) => options.onLog?.(String(message)),
  });
  return buildRemoteArtifactDownloadCommand({
    tool: tools.download,
    urls: options.release.urls,
    outputPath: options.remoteArchive,
    progressLabel: `Source Server ${options.release.target}`,
    totalBytes: options.release.sizeBytes,
    expectedSha256: options.release.sha256,
    sha256Tool: tools.sha256,
    supportsProgress: tools.supportsProgress,
  });
}
