// @vitest-environment jsdom
import { createElement, useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IProjectService } from "@/project-sidebar/contract.js";
import { ProjectCreation } from "@/project-sidebar/ProjectCreation.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

Element.prototype.scrollIntoView = vi.fn();
const state = vi.hoisted(() => ({
  hasManagement: true,
  boundaryVersion: 1,
  readBoundary: vi.fn<() => Promise<{ remoteBoundaryIntroAcknowledgedVersion: number }>>(),
  markBoundary: vi.fn(),
  locale: undefined as undefined | "zh-CN" | "en-US",
  devices: [{ sourceServerId: "source", displayName: "Saved device", aggregatedStatus: "online" }],
  confirm: vi.fn(async () => true),
  select: undefined as undefined | (() => Promise<string[]>),
  refresh: undefined as undefined | (() => void),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        if (!state.locale) return id;
        const messages: Record<string, string> = state.locale === "zh-CN" ? zhCN : enUS;
        return messages[id] ?? id;
      },
    },
  }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => {
  const management = {
    getSnapshot: vi.fn(async () => ({
      generation: 1,
      servers: state.devices.map((device) => ({
        sourceServerId: device.sourceServerId,
        displayName: device.displayName,
        installState: "installed",
      })),
      profiles: [
        {
          profileId: "unrecognized",
          displayName: "Unrecognized profile",
          lifecycleState: "active",
          transport: "ssh",
          target: { kind: "ssh", host: "unknown.example.com", username: "dev" },
        },
        ...state.devices.map((device) => ({
          profileId: device.sourceServerId,
          sourceServerId: device.sourceServerId,
          lifecycleState: "active",
          transport: "ssh",
          target: { kind: "ssh", host: "device.example.com", username: "dev" },
        })),
      ],
      states: state.devices.map((device) => ({
        profileId: device.sourceServerId,
        sourceServerId: device.sourceServerId,
        state: device.aggregatedStatus,
        updatedAt: 1,
      })),
    })),
    onDidChangeState: (listener: () => void) => {
      state.refresh = listener;
      return {
        dispose() {
          state.refresh = undefined;
        },
      };
    },
  };
  const settingService = {
    get: () => state.readBoundary(),
    update: async (patch: { remoteBoundaryIntroAcknowledgedVersion?: number }) => {
      state.markBoundary(patch);
      if (patch.remoteBoundaryIntroAcknowledgedVersion !== undefined)
        state.boundaryVersion = patch.remoteBoundaryIntroAcknowledgedVersion;
    },
  };
  return {
    useOptionalBaseWorkspaceServices: () => ({
      sourceServerManagementService: state.hasManagement ? management : undefined,
      settingService,
    }),
  };
});
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => state.confirm }));
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({
    selectDirectories: state.select,
    listSSHConfigAliases: async () => [
      { alias: "Discovery candidate", hostName: "candidate.example.com", user: "dev" },
    ],
  }),
}));
vi.mock("@/DirectoryBrowser.js", () => ({
  DirectoryBrowser: ({ onSelect }: { onSelect(path: string): void }) =>
    createElement("button", { onClick: () => onSelect("/source/selected") }, "choose-root"),
}));
beforeEach(() => {
  useZCodeSessionStore.setState({ workspaces: {} });
  useZCodeSessionStore.getState().startDraft("/draft", undefined, undefined, {
    projectId: "original",
    taskGroupId: "group",
  });
  state.hasManagement = true;
  state.boundaryVersion = 1;
  state.readBoundary.mockReset().mockImplementation(async () => ({
    remoteBoundaryIntroAcknowledgedVersion: state.boundaryVersion,
  }));
  state.markBoundary.mockReset();
});
afterEach(() => {
  cleanup();
  state.locale = undefined;
  state.confirm.mockReset().mockResolvedValue(true);
  state.select = undefined;
  state.devices[0]!.aggregatedStatus = "online";
});
async function setup(defaultDeviceId?: string) {
  const saved = { id: "project", hostId: defaultDeviceId ?? "local", name: "Draft", roots: [] };
  const service = {
    readTree: vi.fn<IProjectService["readTree"]>(async () => ({ projects: [], tasks: [] })),
    saveProject: vi.fn(async (input) => ({ ...saved, hostId: input.hostId ?? "local" })),
    readDirectory: vi.fn(async () => ({ path: "/", entries: [] })),
  };
  const remoteService = {
    readDirectory: vi.fn(async () => ({
      entries: [],
      hosts: [{ id: "remote:server:source", membershipId: "member" }],
    })),
    addEntry: vi.fn(async () => {}),
    saveHost: vi.fn(async () => ({ id: "remote:server:source", membershipId: "member" })),
  };
  const props = {
    workspacePath: "/draft",
    onCreateTask: vi.fn(),
    allowDeviceManagement: true,
    projects: [],
    directory: { entries: [], hosts: [] },
    defaultDeviceId,
    service,
    remoteService,
    onOpenRemoteWorkspace: vi.fn(),
    onConnectRemote: vi.fn(),
    onCancelRemote: vi.fn(),
    onClose: vi.fn(),
    onSaved: vi.fn(async () => {}),
  };
  const result = render(createElement(ProjectCreation, props as never));
  await act(async () => {});
  return { ...result, props, service, remoteService };
}
async function selectDevice(id: string) {
  fireEvent.click(screen.getByTestId("virtual-project-device"));
  fireEvent.click(
    await screen.findByRole("option", {
      name: new RegExp(id === "local" ? "project.thisComputer" : "Saved device"),
    }),
  );
}
it("opens the complete form directly and creates a local project without folders", async () => {
  const { service } = await setup();
  fireEvent.change(screen.getByTestId("virtual-project-name"), { target: { value: "Draft" } });
  expect(screen.getByTestId("virtual-project-device").textContent).toContain(
    "project.thisComputer",
  );
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await waitFor(() =>
    expect(service.saveProject).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Draft", roots: [] }),
    ),
  );
});
it("selects the saved project only after directory refresh and preserves the draft group", async () => {
  const { props } = await setup();
  let finish!: () => void;
  props.onSaved.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
  expect(props.onCreateTask).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(props.onCreateTask).toHaveBeenCalledExactlyOnceWith({
    projectId: "project",
    hostId: "local",
    taskGroupId: "group",
    initialComposerDraft: { sourceWorkspaceKey: "/draft", draft: { text: "" }, attachments: [] },
  });
});
it.each(["existing", "save", "refresh", "draft", "workspace", "failure"])(
  "does not select a created project after %s invalidates the draft",
  async (boundary) => {
    if (boundary === "existing") useZCodeSessionStore.getState().setActiveTaskId("/draft", "task");
    const { props, service, rerender } = await setup();
    if (boundary === "save")
      service.saveProject.mockImplementationOnce(async () => {
        useZCodeSessionStore.getState().setActiveTaskId("/draft", "task");
        return { id: "project", hostId: "local", name: "Draft", roots: [] };
      });
    props.onSaved.mockImplementation(async () => {
      if (boundary === "refresh") useZCodeSessionStore.getState().setActiveTaskId("/draft", "task");
      if (boundary === "draft") useZCodeSessionStore.getState().startDraft("/draft");
      if (boundary === "workspace")
        rerender(createElement(ProjectCreation, { ...props, workspacePath: "/other" } as never));
    });
    if (boundary === "failure") service.saveProject.mockRejectedValueOnce(new Error("save failed"));
    fireEvent.click(screen.getByTestId("virtual-project-save"));
    await waitFor(() =>
      boundary === "failure"
        ? expect(screen.getByRole("alert").textContent).toContain("save failed")
        : expect(props.onClose).toHaveBeenCalled(),
    );
    expect(props.onCreateTask).not.toHaveBeenCalled();
  },
);
it("selects an added device without connecting and persists only after explicit create", async () => {
  const { service, remoteService, props } = await setup();
  fireEvent.change(screen.getByTestId("virtual-project-name"), {
    target: { value: "Remote draft" },
  });
  await selectDevice("remote:server:source");
  expect(props.onConnectRemote).not.toHaveBeenCalled();
  expect(service.saveProject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  fireEvent.click(await screen.findByText("choose-root"));
  expect(service.saveProject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(await screen.findByTestId("project-folder-trust-confirm"));
  await waitFor(() =>
    expect(remoteService.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "remote:server:source", expectedMembershipId: "member" }),
    ),
  );
  expect(service.saveProject).toHaveBeenCalledWith(
    expect.objectContaining({
      name: "Remote draft",
      hostId: "remote:server:source",
      roots: ["/source/selected"],
    }),
  );
  await waitFor(() =>
    expect(props.onCreateTask).toHaveBeenCalledExactlyOnceWith({
      projectId: "project",
      hostId: "remote:server:source",
      taskGroupId: "group",
      initialComposerDraft: { sourceWorkspaceKey: "/draft", draft: { text: "" }, attachments: [] },
    }),
  );
});
it("keeps name and folders when device switch is rejected and clears folders only after confirmation", async () => {
  const { service } = await setup();
  fireEvent.change(screen.getByTestId("virtual-project-name"), { target: { value: "Preserved" } });
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  fireEvent.click(await screen.findByText("choose-root"));
  state.confirm.mockResolvedValueOnce(false);
  await selectDevice("remote:server:source");
  await waitFor(() => expect(state.confirm).toHaveBeenCalledTimes(1));
  expect(screen.getByTitle("/source/selected")).toBeTruthy();
  expect(screen.getByTestId("virtual-project-device").textContent).toContain(
    "project.thisComputer",
  );
  await selectDevice("remote:server:source");
  await waitFor(() => expect(screen.queryByTitle("/source/selected")).toBeNull());
  expect((screen.getByTestId("virtual-project-name") as HTMLInputElement).value).toBe("Preserved");
  expect(service.saveProject).not.toHaveBeenCalled();
});
it("keeps the offline default, waits for explicit connection, and retains draft after cancellation", async () => {
  state.devices[0]!.aggregatedStatus = "offline";
  const { props } = await setup("remote:server:source");
  expect(screen.getByTestId("virtual-project-device").textContent).toContain("offline");
  fireEvent.change(screen.getByTestId("virtual-project-name"), { target: { value: "Preserved" } });
  fireEvent.click(screen.getByRole("button", { name: "project.connectAndBrowse" }));
  await waitFor(() => expect(props.onOpenRemoteWorkspace).toHaveBeenCalledOnce());
  const first = props.onOpenRemoteWorkspace.mock.calls[0]![0];
  expect(first).toMatchObject({
    completion: "device-management",
    preferredSourceServerId: "source",
    returnTarget: expect.objectContaining({ kind: "connect-device" }),
  });
  await act(async () => first.returnTarget.finish({ kind: "cancelled" }));
  expect(((await screen.findByTestId("virtual-project-name")) as HTMLInputElement).value).toBe(
    "Preserved",
  );
  fireEvent.click(screen.getByRole("button", { name: "project.connectAndBrowse" }));
  await act(async () =>
    props.onOpenRemoteWorkspace.mock.calls[1]![0].returnTarget.finish({
      kind: "connected",
      sourceServerId: "source",
    }),
  );
  expect(await screen.findByText("choose-root")).toBeTruthy();
});
it("retries local registration without creating a second remote project", async () => {
  const { service, remoteService } = await setup("remote:server:source");
  remoteService.addEntry.mockRejectedValueOnce(new Error("registration failed"));
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  fireEvent.click(await screen.findByText("choose-root"));
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(await screen.findByTestId("project-folder-trust-confirm"));
  expect((await screen.findByRole("alert")).textContent).toContain("registration failed");
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  await waitFor(() => expect(remoteService.addEntry).toHaveBeenCalledTimes(2));
  expect(service.saveProject).toHaveBeenCalledTimes(1);
});
it("ignores a native picker result after the draft is closed", async () => {
  let finish!: (paths: string[]) => void;
  state.select = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const { unmount, service } = await setup();
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  unmount();
  await setup();
  await act(async () => finish(["/late/old-draft"]));
  expect(screen.queryByTitle("/late/old-draft")).toBeNull();
  expect(service.saveProject).not.toHaveBeenCalled();
});
it("a snapshot refresh does not replace the user's chosen device", async () => {
  const { rerender, props } = await setup("remote:server:source");
  await selectDevice("local");
  state.devices[0]!.aggregatedStatus = "offline";
  await act(async () => state.refresh?.());
  rerender(createElement(ProjectCreation, props as never));
  expect(screen.getByTestId("virtual-project-device").textContent).toContain(
    "project.thisComputer",
  );
});
it("does not expose desktop device management on a shared Host form", async () => {
  const { rerender, props } = await setup();
  rerender(createElement(ProjectCreation, { ...props, allowDeviceManagement: false } as never));
  fireEvent.click(screen.getByTestId("virtual-project-device"));
  expect(screen.queryByRole("option", { name: "project.addRemoteDevice" })).toBeNull();
});
it("admits a recognized device without an open project only on explicit creation", async () => {
  const { service, remoteService } = await setup("remote:server:source");
  Object.assign(state.devices[0]!, {
    profiles: [
      {
        sourceServerId: "source",
        lifecycleState: "active",
        target: { kind: "ssh", host: "device.example.com", username: "dev" },
      },
    ],
  });
  remoteService.readDirectory.mockResolvedValue({ entries: [], hosts: [] });
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  fireEvent.click(await screen.findByText("choose-root"));
  expect(remoteService.saveHost).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(await screen.findByTestId("project-folder-trust-confirm"));
  await waitFor(() => expect(remoteService.addEntry).toHaveBeenCalledOnce());
  expect(remoteService.saveHost).toHaveBeenCalledWith({
    id: "remote:server:source",
    target: { kind: "ssh", host: "device.example.com", username: "dev" },
  });
  expect(remoteService.saveHost.mock.invocationCallOrder[0]).toBeLessThan(
    service.saveProject.mock.invocationCallOrder[0]!,
  );
});

it("preserves the remote restore prompt using the selected device's authoritative projects", async () => {
  const { service } = await setup("remote:server:source");
  service.readTree.mockResolvedValue({
    projects: [
      {
        id: "deleted",
        hostId: "remote:server:source",
        name: "Previous",
        nameOverridden: true,
        roots: [{ rootPath: "/source/selected", position: 0, isPrimary: true }],
        deleted: true,
        pinned: false,
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    tasks: [],
  });
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  fireEvent.click(await screen.findByText("choose-root"));
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  fireEvent.click(await screen.findByTestId("project-folder-trust-confirm"));
  await waitFor(() =>
    expect(service.saveProject).toHaveBeenCalledWith(
      expect.objectContaining({ restoreProjectId: "deleted" }),
    ),
  );
  expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "project.restore" }));
});

it("lists recognized devices only, without discovering candidates or promoting unrecognized profiles", async () => {
  await setup();
  fireEvent.click(screen.getByTestId("virtual-project-device"));
  expect(await screen.findByRole("option", { name: /Saved device/ })).toBeTruthy();
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect(
    screen.queryByRole("option", { name: /Unrecognized profile|Discovery candidate/ }),
  ).toBeNull();
});

it("returns from device settings into the same draft and confirms before replacing its folders", async () => {
  const { rerender, props, service } = await setup();
  const open = vi.fn();
  rerender(createElement(ProjectCreation, { ...props, onOpenRemoteWorkspace: open } as never));
  fireEvent.change(screen.getByTestId("virtual-project-name"), { target: { value: "Round trip" } });
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  fireEvent.click(await screen.findByText("choose-root"));
  fireEvent.click(screen.getByTestId("virtual-project-device"));
  fireEvent.click(await screen.findByRole("option", { name: "project.addRemoteDevice" }));
  expect(open).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("virtual-project-name")).toBeNull();
  const intent = open.mock.calls[0]![0];
  expect(intent.completion).toBe("device-management");
  state.confirm.mockResolvedValueOnce(false);
  await act(async () =>
    intent.returnTarget.finish({ kind: "connected", sourceServerId: "source" }),
  );
  expect((screen.getByTestId("virtual-project-name") as HTMLInputElement).value).toBe("Round trip");
  expect(screen.getByTitle("/source/selected")).toBeTruthy();
  expect(screen.getByTestId("virtual-project-device").textContent).toContain(
    "project.thisComputer",
  );
  expect(state.confirm).toHaveBeenCalledOnce();
  expect(service.saveProject).not.toHaveBeenCalled();
});

it.each(["connected", "cancelled"] as const)(
  "restores the original name only once after %s and ignores a late return",
  async (kind) => {
    const { props, rerender, service, unmount } = await setup();
    const open = vi.fn();
    rerender(createElement(ProjectCreation, { ...props, onOpenRemoteWorkspace: open } as never));
    fireEvent.change(screen.getByTestId("virtual-project-name"), {
      target: { value: "Empty draft" },
    });
    fireEvent.click(screen.getByTestId("virtual-project-device"));
    fireEvent.click(await screen.findByRole("option", { name: "project.addRemoteDevice" }));
    const target = open.mock.calls[0]![0].returnTarget;
    expect(target.isCurrent()).toBe(true);
    await act(async () => target.finish({ kind, sourceServerId: "source" }));
    expect((screen.getByTestId("virtual-project-name") as HTMLInputElement).value).toBe(
      "Empty draft",
    );
    expect(screen.getByTestId("virtual-project-device").textContent).toContain(
      kind === "connected" ? "Saved device" : "project.thisComputer",
    );
    expect(target.isCurrent()).toBe(false);
    expect(service.saveProject).not.toHaveBeenCalled();
    unmount();
    await setup();
    await act(async () => target.finish({ kind: "connected", sourceServerId: "source" }));
    expect((screen.getByTestId("virtual-project-name") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("virtual-project-device").textContent).toContain(
      "project.thisComputer",
    );
  },
);

it("does not hide the draft when the current device operation cannot accept a new origin", async () => {
  const { props, rerender } = await setup();
  rerender(
    createElement(ProjectCreation, { ...props, onOpenRemoteWorkspace: () => false } as never),
  );
  fireEvent.change(screen.getByTestId("virtual-project-name"), { target: { value: "Retained" } });
  fireEvent.click(screen.getByTestId("virtual-project-device"));
  fireEvent.click(await screen.findByRole("option", { name: "project.addRemoteDevice" }));
  expect((screen.getByTestId("virtual-project-name") as HTMLInputElement).value).toBe("Retained");
});

it("does not revive an abandoned draft when device addition finishes later", async () => {
  const { props, rerender, unmount } = await setup();
  const open = vi.fn();
  rerender(createElement(ProjectCreation, { ...props, onOpenRemoteWorkspace: open } as never));
  fireEvent.click(screen.getByTestId("virtual-project-device"));
  fireEvent.click(await screen.findByRole("option", { name: "project.addRemoteDevice" }));
  const target = open.mock.calls[0]![0].returnTarget;
  unmount();
  await setup();
  expect(target.isCurrent()).toBe(false);
  await act(async () => target.finish({ kind: "connected", sourceServerId: "source" }));
  expect(screen.getByTestId("virtual-project-device").textContent).toContain(
    "project.thisComputer",
  );
});

it("adds the selected existing identity without creating a project and preserves the creation draft on return", async () => {
  const { service, remoteService } = await setup("remote:server:source");
  const project = {
    id: "existing-one",
    hostId: "remote:server:source",
    name: "Original project",
    nameOverridden: true,
    roots: [{ rootPath: "/same/directory", position: 0, isPrimary: true }],
    deleted: false,
    pinned: false,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  service.readTree.mockResolvedValue({
    projects: [project, { ...project, id: "existing-two", name: "Same directory second identity" }],
    tasks: [],
  });
  fireEvent.change(screen.getByTestId("virtual-project-name"), {
    target: { value: "Preserved draft" },
  });
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  fireEvent.click(await screen.findByText("choose-root"));
  fireEvent.click(screen.getByTestId("virtual-project-existing"));
  expect(await screen.findByText("Original project")).toBeTruthy();
  expect(screen.getAllByText("/same/directory")).toHaveLength(2);
  fireEvent.click(screen.getByTestId("remote-project-back"));
  expect((screen.getByTestId("virtual-project-name") as HTMLInputElement).value).toBe(
    "Preserved draft",
  );
  expect(screen.getByTitle("/source/selected")).toBeTruthy();
  fireEvent.click(screen.getByTestId("virtual-project-existing"));
  fireEvent.click(await screen.findByText("Same directory second identity"));
  await waitFor(() =>
    expect(remoteService.addEntry).toHaveBeenCalledWith({
      hostId: "remote:server:source",
      expectedMembershipId: "member",
      project: {
        projectId: "existing-two",
        name: "Same directory second identity",
        roots: project.roots,
      },
    }),
  );
  expect(service.saveProject).not.toHaveBeenCalled();
});

it("keeps the existing-project intent through an offline connection without browsing folders", async () => {
  state.devices[0]!.aggregatedStatus = "offline";
  const { service, props } = await setup("remote:server:source");
  fireEvent.click(screen.getByTestId("virtual-project-existing"));
  await waitFor(() => expect(props.onOpenRemoteWorkspace).toHaveBeenCalledOnce());
  expect(props.onOpenRemoteWorkspace.mock.calls[0]![0].returnTarget.kind).toBe("connect-device");
  await act(async () =>
    props.onOpenRemoteWorkspace.mock.calls[0]![0].returnTarget.finish({
      kind: "connected",
      sourceServerId: "source",
    }),
  );
  expect(await screen.findByTestId("remote-project-back")).toBeTruthy();
  expect(screen.queryByText("choose-root")).toBeNull();
  expect(service.saveProject).not.toHaveBeenCalled();
});

it("discards a delayed existing-project list after returning and switching devices", async () => {
  const { service, remoteService } = await setup("remote:server:source");
  let finish!: (tree: Awaited<ReturnType<IProjectService["readTree"]>>) => void;
  service.readTree.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByTestId("virtual-project-existing"));
  fireEvent.click(await screen.findByTestId("remote-project-back"));
  await selectDevice("local");
  await act(async () => finish({ projects: [], tasks: [] }));
  expect(screen.queryByTestId("remote-project-back")).toBeNull();
  expect(screen.getByTestId("virtual-project-device").textContent).toContain(
    "project.thisComputer",
  );
  expect(remoteService.addEntry).not.toHaveBeenCalled();
});

it("can add a read-only legacy project while the new-project action stays unavailable", async () => {
  const { service, remoteService } = await setup("remote:server:source");
  const project = {
    id: "legacy-project",
    hostId: "remote:server:source",
    name: "Legacy original",
    nameOverridden: true,
    roots: [{ rootPath: "/original", position: 0, isPrimary: true }],
    deleted: false,
    pinned: false,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  service.readTree.mockResolvedValue({ projects: [project], tasks: [], legacySingleRoot: true });
  fireEvent.click(screen.getByTestId("virtual-project-existing"));
  expect(await screen.findByText("Legacy original")).toBeTruthy();
  expect(screen.queryByTestId("remote-project-new")).toBeNull();
  fireEvent.click(screen.getByTestId("remote-project-back"));
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  fireEvent.click(await screen.findByText("choose-root"));
  expect((screen.getByTestId("virtual-project-save") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTestId("virtual-project-existing"));
  fireEvent.click(await screen.findByText("Legacy original"));
  await waitFor(() => expect(remoteService.addEntry).toHaveBeenCalledOnce());
  expect(service.saveProject).not.toHaveBeenCalled();
});

it("does not register an existing project after its pending selection is cancelled", async () => {
  const { service, remoteService } = await setup("remote:server:source");
  service.readTree.mockResolvedValue({
    projects: [
      {
        id: "existing",
        hostId: "remote:server:source",
        name: "Original",
        nameOverridden: true,
        roots: [],
        deleted: false,
        pinned: false,
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    tasks: [],
  });
  fireEvent.click(screen.getByTestId("virtual-project-existing"));
  await screen.findByText("Original");
  let finish!: (directory: {
    hosts: { id: string; membershipId: string }[];
    entries: never[];
  }) => void;
  remoteService.readDirectory.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByText("Original"));
  fireEvent.click(screen.getByTestId("remote-project-back"));
  await act(async () =>
    finish({ hosts: [{ id: "remote:server:source", membershipId: "member" }], entries: [] }),
  );
  expect(remoteService.addEntry).not.toHaveBeenCalled();
  expect(remoteService.saveHost).not.toHaveBeenCalled();
});

it("background cancellation leaves the project draft hidden until its original tab is active", async () => {
  const { props, unmount } = await setup();
  unmount();
  const { TabStoreProvider, useTabStoreApi } = await import("@/store/TabStoreProvider.js");
  let tabs!: ReturnType<typeof useTabStoreApi>;
  function Harness() {
    tabs = useTabStoreApi();
    const [ready, setReady] = useState(false);
    useEffect(() => {
      tabs.getState().addTab("/project-origin");
      setReady(true);
    }, []);
    return ready ? createElement(ProjectCreation, props as never) : null;
  }
  render(createElement(TabStoreProvider, null, createElement(Harness)));
  fireEvent.change(await screen.findByTestId("virtual-project-name"), {
    target: { value: "Retained" },
  });
  fireEvent.click(screen.getByTestId("virtual-project-device"));
  fireEvent.click(await screen.findByRole("option", { name: "project.addRemoteDevice" }));
  const request = props.onOpenRemoteWorkspace.mock.calls[0]![0];
  const origin = tabs.getState().activeTabId!;
  act(() => tabs.getState().openSettingsTab());
  await act(async () => request.returnTarget.finish({ kind: "cancelled", background: true }));
  expect(screen.queryByTestId("virtual-project-name")).toBeNull();
  act(() => tabs.getState().activateTab(origin));
  expect(((await screen.findByTestId("virtual-project-name")) as HTMLInputElement).value).toBe(
    "Retained",
  );
});

it.each([
  ["zh-CN", "remote-project.host-removed", "此设备已从项目列表移除，请重新选择设备。"],
  [
    "en-US",
    "remote-project.host-removed",
    "This device was removed from the project list. Select a device again.",
  ],
  ["zh-CN", "project.connection-unavailable", "此设备不可用，请在设置中重新连接。"],
  [
    "en-US",
    "project.connection-unavailable",
    "This device is unavailable. Reconnect it in settings.",
  ],
  ["zh-CN", "permission denied: /project", "permission denied: /project"],
  ["en-US", "permission denied: /project", "permission denied: /project"],
] as const)("shows project save errors in %s: %s", async (locale, code, message) => {
  state.locale = locale;
  const { service } = await setup();
  service.saveProject.mockRejectedValueOnce(new Error(code));
  fireEvent.click(screen.getByTestId("virtual-project-save"));
  expect((await screen.findByRole("alert")).textContent).toContain(message);
  expect((await screen.findByRole("alert")).textContent).not.toContain("remote-project.");
});

it.each([
  ["zh-CN", "remote-project.host-removed", "此设备已从项目列表移除，请重新选择设备。"],
  [
    "en-US",
    "remote-project.host-removed",
    "This device was removed from the project list. Select a device again.",
  ],
  ["zh-CN", "permission denied: /project", "permission denied: /project"],
  ["en-US", "permission denied: /project", "permission denied: /project"],
] as const)("shows existing-project errors in %s: %s", async (locale, code, message) => {
  state.locale = locale;
  const { service, remoteService } = await setup("remote:server:source");
  service.readTree.mockResolvedValue({
    projects: [{ id: "existing", hostId: "remote:server:source", name: "Original", roots: [] }],
    tasks: [],
  } as never);
  remoteService.addEntry.mockRejectedValueOnce(new Error(code));
  fireEvent.click(screen.getByTestId("virtual-project-existing"));
  fireEvent.click(await screen.findByText("Original"));
  expect((await screen.findByRole("alert")).textContent).toContain(message);
  expect((await screen.findByRole("alert")).textContent).not.toContain("remote-project.");
});

it("keeps shared Host devices without Source management or device-add permissions", async () => {
  state.hasManagement = false;
  const { props, rerender, service } = await setup("remote:server:source");
  rerender(
    createElement(ProjectCreation, {
      ...props,
      allowDeviceManagement: false,
      directory: {
        entries: [],
        hosts: [
          {
            id: "remote:server:source",
            membershipId: "member",
            kind: "ssh",
            connectionStatus: "online",
            target: { kind: "ssh", host: "device.example.com", username: "dev" },
          },
        ],
      },
    } as never),
  );
  fireEvent.click(screen.getByTestId("virtual-project-device"));
  const remote = await screen.findByRole("option", { name: /device.example.com/ });
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect(screen.queryByRole("option", { name: "project.addRemoteDevice" })).toBeNull();
  fireEvent.click(remote);
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  fireEvent.click(await screen.findByText("choose-root"));
  expect(screen.getByTitle("/source/selected")).toBeTruthy();
  expect(props.onOpenRemoteWorkspace).not.toHaveBeenCalled();
  expect(service.saveProject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("virtual-project-existing"));
  expect(await screen.findByTestId("remote-project-back")).toBeTruthy();
  expect(service.readTree).toHaveBeenCalledWith({
    hostId: "remote:server:source",
    includeDeleted: true,
  });
});

it("waits for explicit acknowledgement before browsing and remembers it across forms", async () => {
  state.boundaryVersion = 0;
  const acknowledgement = Promise.withResolvers<boolean>();
  state.confirm.mockImplementationOnce(() => acknowledgement.promise);
  const { unmount } = await setup("remote:server:source");
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  await waitFor(() =>
    expect(state.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ presentation: "source-server-boundary" }),
    ),
  );
  expect(state.markBoundary).not.toHaveBeenCalled();
  expect(screen.queryByTestId("virtual-project-directory-browser")).toBeNull();
  await act(async () => acknowledgement.resolve(true));
  await screen.findByTestId("virtual-project-directory-browser");
  expect(state.markBoundary).toHaveBeenCalledWith({ remoteBoundaryIntroAcknowledgedVersion: 1 });
  unmount();
  await setup("remote:server:source");
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  await screen.findByTestId("virtual-project-directory-browser");
  expect(state.confirm).toHaveBeenCalledTimes(1);
  expect(state.markBoundary).toHaveBeenCalledTimes(1);
});

it("does not consume the remote continuity hint in a local directory browser", async () => {
  state.boundaryVersion = 0;
  await setup();
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  expect(await screen.findByText("choose-root")).toBeTruthy();
  expect(screen.queryByTestId("remote-boundary-hint")).toBeNull();
  expect(state.markBoundary).not.toHaveBeenCalled();
});

it("does not mark the remote hint read when its setting read fails or returns after closing", async () => {
  state.readBoundary.mockRejectedValueOnce(new Error("read unavailable"));
  const first = await setup("remote:server:source");
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  await waitFor(() => expect(state.readBoundary).toHaveBeenCalled());
  expect(state.markBoundary).not.toHaveBeenCalled();
  first.unmount();
  const pending = Promise.withResolvers<{ remoteBoundaryIntroAcknowledgedVersion: number }>();
  state.readBoundary.mockReturnValueOnce(pending.promise);
  const second = await setup("remote:server:source");
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  second.unmount();
  await act(async () => pending.resolve({ remoteBoundaryIntroAcknowledgedVersion: 0 }));
  expect(state.markBoundary).not.toHaveBeenCalled();
});

it("does not consume a delayed hint when the project directory is suspended", async () => {
  const pending = Promise.withResolvers<{ remoteBoundaryIntroAcknowledgedVersion: number }>();
  state.readBoundary.mockReturnValueOnce(pending.promise);
  const props = {
    project: null,
    host: { id: "remote:server:source" },
    projects: [],
    service: { readDirectory: async () => ({ path: "/", entries: [] }) },
    onClose: vi.fn(),
    onSaved: vi.fn(),
  };
  const { rerender } = render(createElement(ProjectEditor, props as never));
  fireEvent.click(screen.getByTestId("virtual-project-browse"));
  await waitFor(() => expect(state.readBoundary).toHaveBeenCalled());
  rerender(createElement(ProjectEditor, { ...props, suspended: true } as never));
  await act(async () => pending.resolve({ remoteBoundaryIntroAcknowledgedVersion: 0 }));
  expect(state.markBoundary).not.toHaveBeenCalled();
});
