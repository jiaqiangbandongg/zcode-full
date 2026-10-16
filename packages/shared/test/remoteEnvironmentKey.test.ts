import { describe, expect, it } from "vitest";
import { buildRemoteEnvironmentKey } from "../src/remoteEnvironmentKey.js";

describe("buildRemoteEnvironmentKey", () => {
  it("ignores workspace/session facts and normalizes every remote target kind", () => {
    expect(buildRemoteEnvironmentKey({ kind: "ssh", host: "EXAMPLE.COM", username: "dev" })).toBe(
      buildRemoteEnvironmentKey({ kind: "ssh", host: "example.com", port: 22, username: "dev" }),
    );
    expect(buildRemoteEnvironmentKey({ kind: "wsl", distro: " Ubuntu ", user: "dev" })).toBe(
      "wsl:Ubuntu\0dev",
    );
    expect(buildRemoteEnvironmentKey({ kind: "docker", container: " zcode-dev " })).toBe(
      "docker:zcode-dev",
    );
    expect(
      buildRemoteEnvironmentKey({ kind: "server", url: "wss://host.example/ws?token=x" }),
    ).toBe("server:https://host.example");
    expect(
      buildRemoteEnvironmentKey({ kind: "server", serverId: "srv-1", url: "https://ignored" }),
    ).toBe("server:srv-1");
  });
});
