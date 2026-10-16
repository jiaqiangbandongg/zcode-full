import { describe, expect, it } from "vitest";
import { sanitizeModelNetworkHeaders } from "../src/model/runner-network-headers.js";

describe("sanitizeModelNetworkHeaders", () => {
  it("redacts sensitive request and response headers", () => {
    expect(
      sanitizeModelNetworkHeaders({
        Authorization: "Bearer secret",
        "x-api-key": "api-secret",
        "x-off-peak-ticket-id": "ticket-secret",
        "x-provider-token": "provider-secret",
        Cookie: "sid=secret",
        "content-type": "application/json",
      }),
    ).toEqual({
      authorization: "[redacted]",
      "x-api-key": "[redacted]",
      "x-off-peak-ticket-id": "[redacted]",
      "x-provider-token": "[redacted]",
      cookie: "[redacted]",
      "content-type": "application/json",
    });
  });
});
