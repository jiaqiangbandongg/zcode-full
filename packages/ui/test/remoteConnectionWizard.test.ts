import { describe, expect, it } from "vitest";
import { normalizeRemoteResourcePackageSelection } from "@zcode/shared";
import {
  buildRemoteTarget,
  buildRemoteTargetFromProfile,
  collectRemoteFormFieldErrors,
  formatRemoteDraftPreview,
  findSourceServerUpgradeProfileId,
  withDefaultRemoteResourcePackages,
} from "@/lib/remoteConnectionWizard.js";

const intl = {
  formatMessage: ({ id }: { id: string }) => id,
};

describe("buildRemoteTarget", () => {
  it("按精确线路和必须升级状态定位连接向导的更新目标", () => {
    expect(
      findSourceServerUpgradeProfileId(
        {
          profiles: [
            {
              profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
              transport: "ssh",
              target: {
                kind: "ssh",
                host: "dev.internal",
                username: "dev",
              },
              createdAt: 1,
            },
          ],
          states: [
            {
              profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
              state: "needs-upgrade",
              updateAvailability: "required",
              upgradeTarget: "server",
              updatedAt: 2,
            },
          ],
        } as never,
        {
          kind: "ssh",
          host: "dev.internal",
          port: 22,
          username: "dev",
          password: "secret",
        },
      ),
    ).toBe("17ef20b3-622d-4a53-98c1-0cdff29f3e6d");
  });

  it("reuses saved profile metadata without exposing credential keys", () => {
    expect(
      buildRemoteTargetFromProfile({
        profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
        transport: "ssh",
        sourceServerId: "3cd4f9da-cd79-426c-9d70-75f36e9f6a87",
        displayName: "backup",
        target: {
          kind: "ssh",
          host: "dev.internal",
          username: "dev",
          passwordCredentialKey: "connection-profile:p:password",
          privateKeyPassphraseCredentialKey: "connection-profile:p:passphrase",
        },
        createdAt: 1,
        lifecycleState: "active",
      }),
    ).toEqual({
      kind: "ssh",
      host: "dev.internal",
      username: "dev",
    });
  });

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

const emptySsh = {
  kind: "ssh" as const,
  host: "",
  port: "22",
  username: "",
  sshAuthMethod: "password" as const,
  password: "",
  privateKeyPath: "",
  privateKeyPassphrase: "",
  wslDistro: "",
  dockerContainer: "",
};

describe("collectRemoteFormFieldErrors", () => {
  it("SSH 按页面顺序列出所有字段错误，buildRemoteTarget 返回第一条", () => {
    const snapshot = { ...emptySsh, port: "70000" };
    expect(collectRemoteFormFieldErrors(intl, snapshot)).toEqual([
      { field: "host", message: "ssh.validation.hostRequired" },
      { field: "port", message: "ssh.validation.port" },
      { field: "username", message: "ssh.validation.usernameRequired" },
      { field: "password", message: "ssh.validation.passwordRequired" },
    ]);
    expect(buildRemoteTarget(intl, snapshot)).toEqual({
      errorMessage: "ssh.validation.hostRequired",
    });
  });

  it("端口只有空白时按未填写处理，和校验读取同一个值", () => {
    const snapshot = { ...emptySsh, host: "h", username: "u", password: "p", port: "   " };
    expect(collectRemoteFormFieldErrors(intl, snapshot)).toEqual([]);
    expect(buildRemoteTarget(intl, snapshot).target).toMatchObject({
      kind: "ssh",
      port: undefined,
    });
    expect(buildRemoteTarget(intl, { ...snapshot, port: " 2222 " }).target).toMatchObject({
      port: 2222,
    });
  });

  it("私钥模式要求私钥路径；已保存密码时可不填密码", () => {
    expect(
      collectRemoteFormFieldErrors(intl, {
        ...emptySsh,
        host: "h",
        username: "u",
        sshAuthMethod: "privateKey",
      }),
    ).toEqual([{ field: "privateKey", message: "ssh.validation.privateKeyRequired" }]);
    expect(
      collectRemoteFormFieldErrors(
        intl,
        { ...emptySsh, host: "h", username: "u" },
        { passwordOptional: true },
      ),
    ).toEqual([]);
  });

  it("Docker、WSL、Server 各自映射到对应字段", () => {
    expect(collectRemoteFormFieldErrors(intl, { ...emptySsh, kind: "docker" })).toEqual([
      { field: "docker", message: "docker.validation.required" },
    ]);
    expect(
      collectRemoteFormFieldErrors(intl, { ...emptySsh, kind: "wsl", wslUser: "bad:user" }),
    ).toEqual([{ field: "wslUser", message: "wsl.validation.invalidUser" }]);
    expect(
      collectRemoteFormFieldErrors(intl, { ...emptySsh, kind: "server", serverUrl: "nope" }),
    ).toEqual([{ field: "serverUrl", message: "server.validation.invalidUrl" }]);
  });
});

describe("formatRemoteDraftPreview", () => {
  it("SSH 有主机才生成预览，缺用户名和端口时使用占位", () => {
    expect(formatRemoteDraftPreview(emptySsh)).toBeNull();
    expect(formatRemoteDraftPreview({ ...emptySsh, host: " 10.0.0.5 ", port: "" })).toBe(
      "user@10.0.0.5:22",
    );
    expect(
      formatRemoteDraftPreview({ ...emptySsh, host: "h", username: "root", port: "2222" }),
    ).toBe("root@h:2222");
  });

  it("Docker 优先手动输入，WSL 使用发行版，Server 使用 URL", () => {
    expect(
      formatRemoteDraftPreview({
        ...emptySsh,
        kind: "docker",
        dockerContainer: "listed",
        manualDockerContainer: " manual ",
      }),
    ).toBe("manual");
    expect(formatRemoteDraftPreview({ ...emptySsh, kind: "docker", dockerContainer: "web" })).toBe(
      "web",
    );
    expect(formatRemoteDraftPreview({ ...emptySsh, kind: "wsl" })).toBeNull();
    expect(formatRemoteDraftPreview({ ...emptySsh, kind: "wsl", wslDistro: "Ubuntu" })).toBe(
      "Ubuntu",
    );
    expect(
      formatRemoteDraftPreview({ ...emptySsh, kind: "server", serverUrl: "https://example.com" }),
    ).toBe("https://example.com");
  });
});
