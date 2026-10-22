import { describe, expect, it } from "vitest";
import {
  createShareImportIntent,
  isShareImportIntentSame,
  resolveShareImportFailurePresentation,
  type ShareImportIntent,
} from "../src/root/shareImportIntent.js";

describe("share import intent", () => {
  it.each(["network", "service_unavailable", "unknown", "rate_limited"])(
    "keeps transport failure %s retryable",
    (kind) => {
      expect(resolveShareImportFailurePresentation(kind).retryable).toBe(true);
    },
  );
  it("keeps actual contract corruption non-retryable", () => {
    expect(resolveShareImportFailurePresentation("invalid_contract")).toEqual({
      messageId: "conversationShare.import.integrityFailed",
      retryable: false,
    });
  });
  it.each([
    ["import_not_allowed", "conversationShare.import.notAllowed"],
    ["not_found", "conversationShare.import.notFound"],
    ["expired", "conversationShare.import.expired"],
    ["unsupported_schema_version", "conversationShare.import.unsupportedVersion"],
  ])("does not offer an ineffective retry for %s", (kind, messageId) => {
    expect(resolveShareImportFailurePresentation(kind)).toEqual({ messageId, retryable: false });
  });

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
      messageId: "conversationShare.error.network",
      retryable: true,
    });
  });
});
