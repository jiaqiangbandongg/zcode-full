import { describe, expect, it } from "vitest";
import { getPublicEgressIpBlockReason } from "../src/index.js";

describe("public egress IP classifier", () => {
  it.each([
    ["127.0.0.1", "loopback IPv4 address"],
    ["169.254.169.254", "link-local IPv4 address"],
    ["::1", "loopback IPv6 address"],
    ["fe80::1", "link-local IPv6 address"],
    ["::ffff:7f00:1", "loopback IPv4 address"],
    ["::ffff:a9fe:a9fe", "link-local IPv4 address"],
    ["240.0.0.1", "reserved IPv4 address"],
    ["255.255.255.255", "reserved IPv4 address"],
  ])("blocks non-public address %s", (address, reason) => {
    expect(getPublicEgressIpBlockReason(address)).toMatchObject({ reason });
  });

  it.each(["8.8.8.8", "2606:4700:4700::1111", "::ffff:0808:0808"])(
    "allows public address %s",
    (address) => {
      expect(getPublicEgressIpBlockReason(address)).toBeUndefined();
    },
  );
});
