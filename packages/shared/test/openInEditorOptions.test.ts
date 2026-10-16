import { describe, expect, it } from "vitest";
import { createOpenInEditorRemoteTarget } from "../src/platform.js";

describe("createOpenInEditorRemoteTarget", () => {
  it("SSH target 只保留 VS Code Remote-SSH 打开目录所需字段", () => {
    const remoteTarget = createOpenInEditorRemoteTarget({
      kind: "ssh",
      host: "jumpserver.example.com",
      port: 2222,
      username: "root",
      sshConfigAlias: "zcode",
      password: "secret-password",
      privateKeyPath: "~/.ssh/id_ed25519",
      privateKeyPassphrase: "secret-passphrase",
    });

    expect(remoteTarget).toEqual({
      kind: "ssh",
      host: "jumpserver.example.com",
      port: 2222,
      username: "root",
      sshConfigAlias: "zcode",
    });
    expect(remoteTarget).not.toHaveProperty("password");
    expect(remoteTarget).not.toHaveProperty("privateKeyPath");
    expect(remoteTarget).not.toHaveProperty("privateKeyPassphrase");
  });
});
