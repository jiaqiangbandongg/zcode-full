import { beforeEach, describe, expect, it } from "vitest";
import {
  clearV4ComposerDraftWorkspaceTransferRequest,
  consumeV4ComposerDraftWorkspaceTransferRequest,
  requestV4ComposerDraftWorkspaceTransfer,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";

describe("composer draft workspace transfer", () => {
  beforeEach(() => clearV4ComposerDraftWorkspaceTransferRequest());

  it("is consumed only by the matching source and target workspace", () => {
    requestV4ComposerDraftWorkspaceTransfer({
      sourceWorkspacePath: "/project",
      targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
    });

    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: "/other",
        targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
      }),
    ).toBe(false);
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: "/project",
        targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
      }),
    ).toBe(true);
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: "/project",
        targetWorkspacePath: "/Users/demo/.zcode/workspace/default",
      }),
    ).toBe(false);
  });
});
