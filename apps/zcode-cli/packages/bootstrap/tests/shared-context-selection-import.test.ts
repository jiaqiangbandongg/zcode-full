import { describe, expect, it, vi } from "vitest";
import type { SessionStorePort } from "@zcode/contracts";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createSessionRecordForV4, closeSession } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";

describe("分享上下文导入与当前选择合同", () => {
  it.each(["", "account:zai-individual-coding-plan/GLM-5.3"])(
    "导入保留完整上下文，不要求可执行模型：%s",
    async (model) => {
      const commitSharedContextImportBundle = vi.fn<
        NonNullable<SessionStorePort["commitSharedContextImportBundle"]>
      >(async () => {});
      const resume = vi.fn(async () => undefined);
      const server = new ZCodeProtocolAgentServer({
        sessionStore: { commitSharedContextImportBundle } as unknown as SessionStorePort,
        createZCodeApp: (options) => createFakeApp(options, { getModel: () => model, resume }),
      });
      const context = (server as unknown as { context: ZCodeProtocolAgentServerContext }).context;
      const sessionId = "shared-context-model-test";
      try {
        await expect(
          createSessionRecordForV4(context, {
            sessionId,
            workspace: { workspacePath: "/fixture", workspaceKey: "/fixture" },
            importedHistory: {
              source: "sharedContext",
              title: "来自分享：测试",
              markdown: "保留分享上下文",
              provenance: {
                shareId: "share-test",
                projectionSha256: "a".repeat(64),
                artifactSetSha256: "b".repeat(64),
                markdownSha256: "c".repeat(64),
                formatterVersion: 1,
                installedArtifacts: [],
              },
            },
          }),
        ).resolves.toEqual({ sessionId });
        expect(commitSharedContextImportBundle).toHaveBeenCalledTimes(1);
        const bundle = commitSharedContextImportBundle.mock.calls[0]![0] as unknown as Parameters<
          NonNullable<SessionStorePort["commitSharedContextImportBundle"]>
        >[0];
        expect(bundle.contextMessage.info).not.toHaveProperty("model");
        expect(bundle.contextMessage.info).toMatchObject({
          visibility: "model-only",
          source: "shared_context",
        });
        if (model) {
          expect(bundle.contextMessage.info).toHaveProperty("modelSelection", {
            providerId: "account:zai-individual-coding-plan",
            modelId: "GLM-5.3",
          });
        } else {
          expect(bundle.contextMessage.info).not.toHaveProperty("modelSelection");
        }
        expect(bundle.contextMessage.parts[0]).toMatchObject({ text: "保留分享上下文" });
        expect(resume).toHaveBeenCalledTimes(1);
      } finally {
        if (context.sessions.has(sessionId)) await closeSession(context, { sessionId });
      }
    },
  );
});
