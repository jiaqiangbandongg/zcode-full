import { describe, expect, it } from "vitest";
import {
  formatRemoteProjectConnectionAddress,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";

describe("RPN-14 remote project connection state", () => {
  it("does not display credentials or query tokens from a direct-server URL", () => {
    expect(
      formatRemoteProjectConnectionAddress({
        kind: "server",
        url: "https://user:secret@server.example:8787/ws?token=hidden#private",
      }),
    ).toBe("server.example:8787");
  });
  it("does not paint a retained attachment green after the device went offline", () => {
    expect(resolveRemoteConnectionPresentation({ attached: true, state: "offline" }).status).toBe(
      "offline",
    );
  });
  it("shows an active retry ahead of the previous attempt's error", () => {
    expect(
      resolveRemoteConnectionPresentation({
        attached: false,
        reconnecting: true,
        error: "previous failure",
      }).status,
    ).toBe("connecting");
  });
  it("keeps a single failed attachment distinct from a healthy device", () => {
    expect(
      resolveRemoteConnectionPresentation({
        attached: false,
        state: "online",
        error: "bind failed",
      }).status,
    ).toBe("failed");
  });
  it("uses connecting for device bootstrap and keeps installation gates non-error", () => {
    expect(
      resolveRemoteConnectionPresentation({ attached: false, state: "connecting" }).status,
    ).toBe("connecting");
    expect(resolveRemoteConnectionPresentation({ attached: false, state: "pending" }).status).toBe(
      "pending",
    );
  });
});
