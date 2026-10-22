// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionProfile, SourceServerRecord } from "@zcode/shared";
import { EditConnectionProfileDialog } from "@/remote-connection/EditConnectionProfileDialog.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

const platform = vi.hoisted(() => ({
  listSSHConfigAliases: vi.fn(async () => []),
  listWSLDistros: vi.fn(async () => []),
  isDockerAvailable: vi.fn(async () => false),
  listDockerContainers: vi.fn(async () => []),
  selectFile: vi.fn(async () => "/keys/id_ed25519"),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => platform }));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  platform.listSSHConfigAliases.mockResolvedValue([]);
  platform.isDockerAvailable.mockResolvedValue(false);
  platform.listDockerContainers.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EditConnectionProfileDialog", () => {
  it("updates an SSH connection in a centered save/cancel dialog", async () => {
    const profile: ConnectionProfile = {
      profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
      sourceServerId: "3cd4f9da-cd79-426c-9d70-75f36e9f6a87",
      transport: "ssh",
      displayName: "primary",
      target: {
        kind: "ssh",
        host: "old.example.com",
        port: 22,
        username: "old-user",
        passwordCredentialKey: "connection-profile:p:password",
      },
      createdAt: 1,
      lifecycleState: "active",
    };
    const source: SourceServerRecord = {
      sourceServerId: profile.sourceServerId!,
      displayName: "Old device",
      preferredProfileId: profile.profileId,
      installState: "installed",
      declaredWorkspaces: [],
    };
    const updateProfile = vi.fn(async () => ({ generation: 2 }));
    const onOpenChange = vi.fn();

    render(
      createElement(EditConnectionProfileDialog, {
        open: true,
        profile,
        source,
        management: { updateProfile } as never,
        onOpenChange,
      }),
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      (screen.getByLabelText("settings.source.connectionName") as HTMLInputElement).value,
    ).toBe("primary");
    expect((screen.getByLabelText("settings.source.deviceName") as HTMLInputElement).value).toBe(
      "Old device",
    );
    expect(screen.queryByRole("complementary")).toBeNull();
    fireEvent.change(screen.getByLabelText("settings.source.connectionName"), {
      target: { value: "Build server" },
    });
    fireEvent.change(screen.getByLabelText("ssh.host"), {
      target: { value: "new.example.com" },
    });
    fireEvent.change(screen.getByLabelText("ssh.port"), {
      target: { value: "2222" },
    });
    fireEvent.change(screen.getByLabelText("ssh.username"), {
      target: { value: "dev" },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.saveChanges" }));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith({
        profileId: profile.profileId,
        profileDisplayName: "Build server",
        sshAuthMethod: "password",
        target: {
          kind: "ssh",
          host: "new.example.com",
          port: 2222,
          username: "dev",
          assetInstallMode: "local-download-upload",
        },
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("保存期间禁止重复提交与关闭，失败显示原始原因并允许重试", async () => {
    const profile: ConnectionProfile = {
      profileId: "p",
      transport: "docker",
      displayName: "Container connection",
      target: { kind: "docker", container: "dev" },
      createdAt: 1,
    };
    let fail!: (error: Error) => void;
    const updateProfile = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const onOpenChange = vi.fn();
    render(
      createElement(EditConnectionProfileDialog, {
        open: true,
        profile,
        management: { updateProfile } as never,
        onOpenChange,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "common.saveChanges" }));
    const saving = screen.getByRole("button", { name: "common.saving" });
    expect(saving.getAttribute("aria-busy")).toBe("true");
    fireEvent.submit(saving.closest("form")!);
    fireEvent.keyDown(saving, { key: "Escape" });
    expect(updateProfile).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();
    await act(async () => fail(new Error("Credential vault is locked")));
    expect(screen.getByRole("alert").textContent).toBe("Credential vault is locked");
    expect(
      screen.getByRole("button", { name: "common.saveChanges" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("共用认证分段、私钥选择与下载方式，设备名单独保存", async () => {
    const profile: ConnectionProfile = {
      profileId: "p",
      sourceServerId: "s",
      transport: "ssh",
      displayName: "SSH route",
      target: { kind: "ssh", host: "build", username: "dev", passwordCredentialKey: "secret" },
      createdAt: 1,
    };
    const source: SourceServerRecord = {
      sourceServerId: "s",
      displayName: "Build device",
      installState: "installed",
    };
    const updateProfile = vi.fn(async () => ({}));
    render(
      createElement(EditConnectionProfileDialog, {
        open: true,
        profile,
        source,
        management: { updateProfile } as never,
        onOpenChange: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByLabelText("settings.source.deviceName"), {
      target: { value: "Renamed device" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ssh.auth.privateKey" }));
    expect(
      screen.getByRole("button", { name: "ssh.auth.privateKey" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByTitle("ssh.privateKeySelect"));
    await waitFor(() =>
      expect((screen.getByTestId("ssh-private-key-input") as HTMLInputElement).value).toBe(
        "/keys/id_ed25519",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /ssh.advancedOptions/ }));
    fireEvent.click(screen.getByRole("button", { name: "ssh.assetInstallMode.remote-download" }));
    fireEvent.click(screen.getByRole("button", { name: "common.saveChanges" }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          profileDisplayName: "SSH route",
          sourceDisplayName: "Renamed device",
          sshAuthMethod: "privateKey",
          target: expect.objectContaining({
            privateKeyPath: "/keys/id_ed25519",
            assetInstallMode: "remote-download",
          }),
        }),
      ),
    );
  });

  it("已保存别名显示在控件中，显式清除后不再写回旧别名", async () => {
    const profile: ConnectionProfile = {
      profileId: "p",
      transport: "ssh",
      displayName: "Route",
      target: {
        kind: "ssh",
        host: "build",
        username: "dev",
        sshConfigAlias: "build-alias",
        passwordCredentialKey: "secret",
      },
      createdAt: 1,
    };
    const updateProfile = vi.fn(async () => ({}));
    render(
      createElement(EditConnectionProfileDialog, {
        open: true,
        profile,
        management: { updateProfile } as never,
        onOpenChange: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "ssh.advancedOptions" }));
    const trigger = screen.getByTestId("ssh-config-alias-select");
    await waitFor(() => expect(trigger.textContent).toContain("build-alias"));
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "ssh.configAliasPlaceholder" }));
    fireEvent.click(screen.getByRole("button", { name: "common.saveChanges" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    expect(updateProfile.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        target: {
          kind: "ssh",
          host: "build",
          username: "dev",
          port: 22,
          assetInstallMode: "local-download-upload",
        },
      }),
    );
  });

  it("选择未指定 Port 的 config 别名时按默认 22 保存", async () => {
    platform.listSSHConfigAliases.mockResolvedValue([
      { alias: "new-alias", host: "new-host", username: "dev" },
    ] as never);
    const profile: ConnectionProfile = {
      profileId: "p",
      transport: "ssh",
      displayName: "Route",
      target: { kind: "ssh", host: "build", username: "dev", passwordCredentialKey: "secret" },
      createdAt: 1,
    };
    const updateProfile = vi.fn(async () => ({}));
    render(
      createElement(EditConnectionProfileDialog, {
        open: true,
        profile,
        management: { updateProfile } as never,
        onOpenChange: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "ssh.advancedOptions" }));
    const trigger = screen.getByTestId("ssh-config-alias-select");
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /new-alias/ }));
    fireEvent.click(screen.getByRole("button", { name: "common.saveChanges" }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({
            host: "new-host",
            port: 22,
            sshConfigAlias: "new-alias",
          }),
        }),
      ),
    );
  });

  it("编辑已有 Docker 连接时，下拉改选新容器会替换旧手动值", async () => {
    platform.isDockerAvailable.mockResolvedValue(true);
    platform.listDockerContainers.mockResolvedValue([
      { id: "new", name: "new-container", image: "dev", status: "Up" },
    ] as never);
    const profile: ConnectionProfile = {
      profileId: "p",
      transport: "docker",
      displayName: "Dev",
      target: { kind: "docker", container: "old-container" },
      createdAt: 1,
    };
    const updateProfile = vi.fn(async () => ({}));
    render(
      createElement(EditConnectionProfileDialog, {
        open: true,
        profile,
        management: { updateProfile } as never,
        onOpenChange: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "docker.inputMode.select" }));
    const trigger = screen.getByTestId("docker-container-select");
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText("new-container"));
    fireEvent.click(screen.getByRole("button", { name: "common.saveChanges" }));
    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ target: { kind: "docker", container: "new-container" } }),
      ),
    );
  });

  it.each([
    {
      transport: "wsl" as const,
      target: { kind: "wsl" as const, distro: "Ubuntu", user: "old-user" },
      fieldLabel: "wsl.user",
      fieldValue: "dev",
      expectedTarget: { kind: "wsl", distro: "Ubuntu", user: "dev" },
    },
    {
      transport: "docker" as const,
      target: { kind: "docker" as const, container: "old-container" },
      fieldLabel: "docker.container",
      fieldValue: "zcode-dev",
      expectedTarget: { kind: "docker", container: "zcode-dev" },
    },
  ])("updates a $transport connection without exposing SSH-only fields", async (entry) => {
    const profile: ConnectionProfile = {
      profileId: "17ef20b3-622d-4a53-98c1-0cdff29f3e6d",
      transport: entry.transport,
      displayName: "saved connection",
      target: entry.target,
      createdAt: 1,
      lifecycleState: "active",
    } as ConnectionProfile;
    const updateProfile = vi.fn(async () => ({ generation: 2 }));

    render(
      createElement(EditConnectionProfileDialog, {
        open: true,
        profile,
        management: { updateProfile } as never,
        onOpenChange: vi.fn(),
      }),
    );

    expect(screen.queryByLabelText("ssh.username")).toBeNull();
    fireEvent.change(screen.getByLabelText(entry.fieldLabel), {
      target: { value: entry.fieldValue },
    });
    fireEvent.click(screen.getByRole("button", { name: "common.saveChanges" }));

    await waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith({
        profileId: profile.profileId,
        profileDisplayName: "saved connection",
        target: entry.expectedTarget,
      }),
    );
  });
});

it("设备名为空时提示设备名，不能误报连接名称", async () => {
  const updateProfile = vi.fn();
  render(
    createElement(EditConnectionProfileDialog, {
      open: true,
      profile: {
        profileId: "p",
        sourceServerId: "source",
        transport: "ssh",
        displayName: "connection",
        target: { kind: "ssh", host: "host", username: "dev", passwordCredentialKey: "key" },
        createdAt: 1,
      },
      source: {
        sourceServerId: "source",
        displayName: "Device",
        preferredProfileId: "p",
        installState: "installed",
        declaredWorkspaces: [],
      },
      management: { updateProfile } as never,
      onOpenChange: vi.fn(),
    }),
  );
  fireEvent.change(screen.getByLabelText("settings.source.deviceName"), { target: { value: " " } });
  fireEvent.click(screen.getByRole("button", { name: "common.saveChanges" }));
  expect(screen.getByRole("alert").textContent).toBe("settings.source.deviceNameRequired");
  expect(updateProfile).not.toHaveBeenCalled();
});

it("连接字段错误显示在对应字段下方，并聚焦第一个出错字段", async () => {
  const updateProfile = vi.fn();
  render(
    createElement(EditConnectionProfileDialog, {
      open: true,
      profile: {
        profileId: "p",
        transport: "ssh",
        displayName: "connection",
        target: { kind: "ssh", host: "host", username: "dev", passwordCredentialKey: "key" },
        createdAt: 1,
      },
      management: { updateProfile } as never,
      onOpenChange: vi.fn(),
    }),
  );
  const host = screen.getByLabelText("ssh.host");
  fireEvent.change(host, { target: { value: " " } });
  fireEvent.change(screen.getByLabelText("ssh.port"), { target: { value: "70000" } });
  fireEvent.click(screen.getByRole("button", { name: "common.saveChanges" }));

  const hostError = (await screen.findByText("ssh.validation.hostRequired")).closest("p")!;
  expect(host.getAttribute("aria-describedby")).toBe(hostError.id);
  expect(screen.getByText("ssh.validation.port")).toBeTruthy();
  // 已保存密码时密码可以留空，不能报密码必填。
  expect(screen.queryByText("ssh.validation.passwordRequired")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.activeElement).toBe(host);
  expect(updateProfile).not.toHaveBeenCalled();
});

it("从修改主机入口打开时，校验失败把焦点给真正出错的字段，而不是被提示的主机", async () => {
  const updateProfile = vi.fn();
  render(
    createElement(EditConnectionProfileDialog, {
      open: true,
      focusField: "host",
      profile: {
        profileId: "p",
        transport: "ssh",
        displayName: "connection",
        target: { kind: "ssh", host: "host", username: "dev", passwordCredentialKey: "key" },
        createdAt: 1,
      },
      management: { updateProfile } as never,
      onOpenChange: vi.fn(),
    }),
  );
  const username = screen.getByLabelText("ssh.username");
  fireEvent.change(username, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "common.saveChanges" }));

  await screen.findByText("ssh.validation.usernameRequired");
  expect(document.activeElement).toBe(username);
  expect(updateProfile).not.toHaveBeenCalled();
});
