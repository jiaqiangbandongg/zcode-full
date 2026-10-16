import type { ToolArtifactStorePort } from "@zcode/contracts";

export function createTestImageArtifactStore(): ToolArtifactStorePort {
  const artifacts = new Map<string, { content: string; contentType: string }>();
  let artifactIndex = 0;
  return {
    async writeToolResultArtifact(request) {
      artifactIndex++;
      const id = `test-image-${artifactIndex}`;
      const uri = `zcode-artifact://${encodeURIComponent(request.sessionId)}/${id}`;
      const contentType = request.contentType ?? "text/plain";
      artifacts.set(uri, { content: request.content, contentType });
      return {
        bytes: Buffer.byteLength(request.content, "utf8"),
        contentType,
        createdAt: new Date(0),
        id,
        uri,
      };
    },
    async readToolResultArtifact(request) {
      const artifact = artifacts.get(request.uri);
      if (!artifact) throw new Error(`Missing test image artifact: ${request.uri}`);
      return {
        bytes: Buffer.byteLength(artifact.content, "utf8"),
        content: artifact.content,
        contentType: artifact.contentType,
        uri: request.uri,
      };
    },
    async ensureMediaAttachmentPath(request) {
      return {
        status: "ready",
        path: `/tmp/zcode-test-image-cache/${encodeURIComponent(request.uri)}.png`,
      } as const;
    },
  };
}
