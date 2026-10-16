import { describe, expect, it } from "vitest";
import { buildSshRemoteHostKey } from "../src/remoteSshHostKey.js";
import { stripRemoteTargetSecrets } from "../src/remoteTarget.js";

describe("buildSshRemoteHostKey", () => {
  it("normalizes host, default port and private key path without resolving the filesystem", () => {
    expect(
      buildSshRemoteHostKey({
        kind: "ssh",
        host: " Mac-Studio ",
        username: " root ",
        privateKeyPath: " c:\\Users\\me\\.ssh\\..\\.ssh\\id_ed25519\\ ",
      }),
    ).toBe(
      buildSshRemoteHostKey({
        kind: "ssh",
        host: "mac-studio",
        port: 22,
        username: "root",
        privateKeyPath: "C:/Users/me/.ssh/id_ed25519",
      }),
    );
  });

  it("keeps Windows, UNC and POSIX roots from being removed by parent segments", () => {
    const target = {
      kind: "ssh" as const,
      host: "example.com",
      username: "root",
    };

    expect(buildSshRemoteHostKey({ ...target, privateKeyPath: String.raw`C:\..\keys` })).toBe(
      buildSshRemoteHostKey({ ...target, privateKeyPath: String.raw`C:\keys` }),
    );
    expect(buildSshRemoteHostKey({ ...target, privateKeyPath: String.raw`C:\..\keys` })).not.toBe(
      buildSshRemoteHostKey({ ...target, privateKeyPath: "keys" }),
    );

    expect(
      buildSshRemoteHostKey({
        ...target,
        privateKeyPath: String.raw`\\server\share\..\keys`,
      }),
    ).toBe(
      buildSshRemoteHostKey({
        ...target,
        privateKeyPath: String.raw`\\server\share\keys`,
      }),
    );
    expect(buildSshRemoteHostKey({ ...target, privateKeyPath: "/../keys" })).toBe(
      buildSshRemoteHostKey({ ...target, privateKeyPath: "/keys" }),
    );
  });

  it("preserves parent segments that cannot be resolved safely", () => {
    const target = {
      kind: "ssh" as const,
      host: "example.com",
      username: "root",
    };

    expect(buildSshRemoteHostKey({ ...target, privateKeyPath: "~/../keys" })).not.toBe(
      buildSshRemoteHostKey({ ...target, privateKeyPath: "keys" }),
    );
    expect(buildSshRemoteHostKey({ ...target, privateKeyPath: "a/../../keys" })).toBe(
      buildSshRemoteHostKey({ ...target, privateKeyPath: "../keys" }),
    );
  });

  it("does not include password or private key passphrase contents", () => {
    expect(
      buildSshRemoteHostKey({
        kind: "ssh",
        host: "example.com",
        username: "Alice",
        password: "first-secret",
      }),
    ).toBe(
      buildSshRemoteHostKey({
        kind: "ssh",
        host: "example.com",
        username: "Alice",
        password: "second-secret",
      }),
    );
    expect(
      buildSshRemoteHostKey({
        kind: "ssh",
        host: "example.com",
        username: "Alice",
        privateKeyPath: "~/.ssh/id_ed25519",
        privateKeyPassphrase: "first-secret",
      }),
    ).toBe(
      buildSshRemoteHostKey({
        kind: "ssh",
        host: "example.com",
        username: "Alice",
        privateKeyPath: "~/.ssh/id_ed25519",
        privateKeyPassphrase: "second-secret",
      }),
    );
  });

  it("keeps auth kind, username case and private key identity distinct", () => {
    const base = { kind: "ssh" as const, host: "example.com", username: "Alice" };
    expect(buildSshRemoteHostKey({ ...base, password: "secret" })).not.toBe(
      buildSshRemoteHostKey(base),
    );
    expect(buildSshRemoteHostKey({ ...base, username: "alice" })).not.toBe(
      buildSshRemoteHostKey(base),
    );
    expect(buildSshRemoteHostKey({ ...base, privateKeyPath: "/keys/a" })).not.toBe(
      buildSshRemoteHostKey({ ...base, privateKeyPath: "/keys/b" }),
    );
  });

  it("infers password auth from a persisted credential reference", () => {
    expect(
      buildSshRemoteHostKey({
        kind: "ssh",
        host: "example.com",
        username: "root",
        passwordCredentialKey: "remote-workspace:one:password",
      }),
    ).toBe(
      buildSshRemoteHostKey({
        kind: "ssh",
        host: "example.com",
        username: "root",
        password: "secret",
      }),
    );
  });
});

describe("stripRemoteTargetSecrets", () => {
  it("removes SSH password material without changing connection identity fields", () => {
    expect(
      stripRemoteTargetSecrets({
        kind: "ssh",
        host: "example.com",
        port: 2222,
        username: "root",
        password: "password-secret",
        privateKeyPath: "/keys/id_ed25519",
        privateKeyPassphrase: "key-secret",
      }),
    ).toEqual({
      kind: "ssh",
      host: "example.com",
      port: 2222,
      username: "root",
      privateKeyPath: "/keys/id_ed25519",
    });
  });

  it("removes server token material without changing server identity fields", () => {
    expect(
      stripRemoteTargetSecrets({
        kind: "server",
        url: "https://studio.example.com",
        name: "Studio",
        serverId: "studio",
        token: "server-secret",
      }),
    ).toEqual({
      kind: "server",
      url: "https://studio.example.com",
      name: "Studio",
      serverId: "studio",
    });
  });
});
