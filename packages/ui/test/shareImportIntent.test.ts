import { describe, expect, it } from "vitest";
import {
  createShareImportIntent,
  isShareImportIntentSame,
  resolveShareImportFailurePresentation,
  type ShareImportIntent,
} from "../src/root/shareImportIntent.js";

describe("share import intent", () => {
  it("creates one stable request id for retries", () => {
    const intent = createShareImportIntent("share-1", () => "request-1");
    expect(intent).toEqual({
      shareCode: "share-1",
      clientRequestId: "request-1",
      status: "received",
    });
  });

  it("coalesces duplicate deep links by request identity", () => {
    const first: ShareImportIntent = {
      shareCode: "share-1",
      clientRequestId: "request-1",
      status: "importing",
    };
    expect(isShareImportIntentSame(first, { shareCode: "share-1" })).toBe(true);
    expect(isShareImportIntentSame(first, { shareCode: "share-2" })).toBe(false);
  });

  it("presents authentication failures as non-retryable anonymous import restrictions", () => {
    expect(resolveShareImportFailurePresentation("authentication_required")).toEqual({
      messageId: "conversationShare.import.loginRequired",
      retryable: false,
    });
    expect(resolveShareImportFailurePresentation("network")).toEqual({
      messageId: "conversationShare.import.failed",
      retryable: true,
    });
  });
});
