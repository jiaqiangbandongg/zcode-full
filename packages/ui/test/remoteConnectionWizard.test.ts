import { describe, expect, it } from "vitest";
import { normalizeRemoteResourcePackageSelection } from "@zcode/shared";
import {
  buildRemoteTarget,
  withDefaultRemoteResourcePackages,
} from "@/lib/remoteConnectionWizard.js";

const intl = {
  formatMessage: ({ id }: { id: string }) => id,
};

describe("buildRemoteTarget", () => {
  it("私钥模式应携带私钥口令而不是登录密码", () => {
    const result = buildRemoteTarget(intl, {
      kind: "ssh",
      host: "demo.internal",
      port: "22",
      username: "root",
      sshAuthMethod: "privateKey",
      password: "",
      privateKeyPath: "~/.ssh/id_ed25519",
      privateKeyPassphrase: "key-secret",
      wslDistro: "",
      dockerContainer: "",
    });

    expect(result).toEqual({
      target: {
        kind: "ssh",
        host: "demo.internal",
        port: 22,
        username: "root",
        privateKeyPath: "~/.ssh/id_ed25519",
        privateKeyPassphrase: "key-secret",
      },
    });
  });

  it("includes the selected SSH asset install mode", () => {
    const result = buildRemoteTarget(intl, {
      kind: "ssh",
      host: "demo.internal",
      port: "22",
      username: "root",
      sshAuthMethod: "password",
      password: "secret",
      privateKeyPath: "",
      privateKeyPassphrase: "",
      assetInstallMode: "remote-download",
      wslDistro: "",
      dockerContainer: "",
    });

    expect(result.target).toMatchObject({
      kind: "ssh",
      assetInstallMode: "remote-download",
    });
  });

  it("includes the selected SSH config alias as target metadata", () => {
    const result = buildRemoteTarget(intl, {
      kind: "ssh",
      host: "localhost",
      port: "2223",
      username: "root",
      sshAuthMethod: "password",
      password: "secret",
      privateKeyPath: "",
      privateKeyPassphrase: "",
      selectedSshConfigAlias: " linux-arm64 ",
      wslDistro: "",
      dockerContainer: "",
    });

    expect(result.target).toMatchObject({
      kind: "ssh",
      sshConfigAlias: "linux-arm64",
    });
  });

  it("omits WSL user when the field is empty", () => {
    const result = buildRemoteTarget(intl, {
      kind: "wsl",
      host: "",
      port: "22",
      username: "",
      sshAuthMethod: "password",
      password: "",
      privateKeyPath: "",
      privateKeyPassphrase: "",
      wslDistro: "Ubuntu-24.04",
      wslUser: "  ",
      dockerContainer: "",
    });

    expect(result).toEqual({
      target: {
        kind: "wsl",
        distro: "Ubuntu-24.04",
      },
    });
  });

  it("trims and includes an explicit WSL user", () => {
    const result = buildRemoteTarget(intl, {
      kind: "wsl",
      host: "",
      port: "22",
      username: "",
      sshAuthMethod: "password",
      password: "",
      privateKeyPath: "",
      privateKeyPassphrase: "",
      wslDistro: "Ubuntu-24.04",
      wslUser: " root ",
      dockerContainer: "",
    });

    expect(result).toEqual({
      target: {
        kind: "wsl",
        distro: "Ubuntu-24.04",
        user: "root",
      },
    });
  });

  it("rejects invalid WSL user before connecting", () => {
    const result = buildRemoteTarget(intl, {
      kind: "wsl",
      host: "",
      port: "22",
      username: "",
      sshAuthMethod: "password",
      password: "",
      privateKeyPath: "",
      privateKeyPassphrase: "",
      wslDistro: "Ubuntu-24.04",
      wslUser: "root/dev",
      dockerContainer: "",
    });

    expect(result).toEqual({
      errorMessage: "wsl.validation.invalidUser",
    });
  });

  it("defaults SSH resource packages when the resource step is skipped", () => {
    const result = buildRemoteTarget(intl, {
      kind: "ssh",
      host: "demo.internal",
      port: "22",
      username: "root",
      sshAuthMethod: "password",
      password: "secret",
      privateKeyPath: "",
      privateKeyPassphrase: "",
      wslDistro: "",
      dockerContainer: "",
    });
    const target = withDefaultRemoteResourcePackages(result.target!);

    expect(target).toMatchObject({
      kind: "ssh",
      resourcePackages: {
        selectedPackageIds: normalizeRemoteResourcePackageSelection(),
      },
    });
  });

  it("Docker 连接优先使用手动输入的容器名", () => {
    const result = buildRemoteTarget(intl, {
      kind: "docker",
      host: "",
      port: "22",
      username: "",
      sshAuthMethod: "password",
      password: "",
      privateKeyPath: "",
      privateKeyPassphrase: "",
      wslDistro: "",
      dockerContainer: "selected-container",
      manualDockerContainer: "  manual-container  ",
    });

    expect(result).toEqual({
      target: {
        kind: "docker",
        container: "manual-container",
      },
    });
  });

  it("Docker 手动输入为空时使用下拉选择的容器名", () => {
    const result = buildRemoteTarget(intl, {
      kind: "docker",
      host: "",
      port: "22",
      username: "",
      sshAuthMethod: "password",
      password: "",
      privateKeyPath: "",
      privateKeyPassphrase: "",
      wslDistro: "",
      dockerContainer: "selected-container",
      manualDockerContainer: "  ",
    });

    expect(result).toEqual({
      target: {
        kind: "docker",
        container: "selected-container",
      },
    });
  });

  it("builds a server remote target from URL and optional token", () => {
    const result = buildRemoteTarget(intl, {
      kind: "server",
      host: "",
      port: "22",
      username: "",
      sshAuthMethod: "password",
      password: "",
      privateKeyPath: "",
      privateKeyPassphrase: "",
      wslDistro: "",
      dockerContainer: "",
      serverUrl: " https://studio.example.com/zcode/ ",
      serverName: " Studio ",
      serverToken: " secret-token ",
      serverWorkspacePath: " /srv/project ",
    });

    expect(result).toEqual({
      target: {
        kind: "server",
        url: "https://studio.example.com/zcode/",
        name: "Studio",
        token: "secret-token",
        workspacePath: "/srv/project",
      },
    });
  });

  it("rejects server targets without URL", () => {
    const result = buildRemoteTarget(intl, {
      kind: "server",
      host: "",
      port: "22",
      username: "",
      sshAuthMethod: "password",
      password: "",
      privateKeyPath: "",
      privateKeyPassphrase: "",
      wslDistro: "",
      dockerContainer: "",
      serverUrl: " ",
    });

    expect(result).toEqual({
      errorMessage: "server.validation.urlRequired",
    });
  });
});
