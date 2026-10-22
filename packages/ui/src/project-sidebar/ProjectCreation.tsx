import { captureV4ComposerDraftHandoff } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useEffect, useRef, useState } from "react";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { logger } from "@/logger.js";
import { buildAggregatedSourceStatusMap } from "@/lib/remoteConnectionPresentation.js";
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@/project-sidebar/contract.js";
import type {
  IProjectService,
  IRemoteProjectService,
  RemoteProjectDirectory,
  VirtualProject,
  ProjectSidebarProps,
  ProjectDevice,
} from "@/project-sidebar/contract.js";
import { ProjectEditor } from "@/project-sidebar/ProjectEditor.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";

export function ProjectCreation({
  workspacePath,
  workspaceIdentity,
  onCreateTask,
  projects,
  directory,
  service,
  remoteService,
  onOpenRemoteWorkspace,
  onClose,
  onSaved,
  defaultDeviceId,
  allowDeviceManagement = false,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  onCreateTask: ProjectSidebarProps["onCreateTask"];
  projects: VirtualProject[];
  directory: RemoteProjectDirectory;
  service: IProjectService;
  remoteService: IRemoteProjectService;
  defaultDeviceId?: string;
  allowDeviceManagement?: boolean;
  onOpenRemoteWorkspace?: ProjectSidebarProps["onOpenRemoteWorkspace"];
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  // Root 的动作 controller 没有装配 projection；设备全集必须直接订阅同一个 Source 服务。
  const management = useOptionalBaseWorkspaceServices()?.sourceServerManagementService;
  const { snapshot } = useSourceServerManagementSnapshot(management);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const statuses = buildAggregatedSourceStatusMap(snapshot);
  useEffect(() => {
    if (snapshot)
      logger.debug("[ProjectCreation] device snapshot", {
        generation: snapshot.generation,
        devices: snapshot.servers.length,
      });
  }, [snapshot]);
  const sidebar = useOptionalProjectDirectory();
  const composerClientNamespace = useComposerClientNamespace();
  const activeTabId = useOptionalTabStore((state) => state.activeTabId);
  const originTabId = useRef(activeTabId);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const currentScope = useRef({ workspaceKey, activeTabId });
  currentScope.current = { workspaceKey, activeTabId };
  const [originDraft] = useState(() => {
    const { activeTaskId, draftFocusVersion, draftProjectId } = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);
    return { workspaceKey, activeTaskId, draftFocusVersion, draftProjectId };
  });
  const active = useRef(true);
  const admittedHosts = useRef(new Map(directory.hosts.map((host) => [host.id, host])));
  const [connection, setConnection] = useState<{
    device?: ProjectDevice;
    resolve(ready: boolean): void;
  } | null>(null);
  const [addingDevice, setAddingDevice] = useState(false);
  const addition = useRef<object | null>(null);
  const pendingConnection = useRef(connection);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      addition.current = null;
      pendingConnection.current?.resolve(false);
    };
  }, []);
  // 手机只有既有 Host 的项目权限，没有 Source 管理能力；能力缺席不能抹掉可用设备。
  const devices: ProjectDevice[] = management
    ? (snapshot?.servers ?? []).map((device) => ({
        id: remoteHostIdFromWorkspaceIdentity(
          buildServerRemoteWorkspaceIdentity({
            serverId: device.sourceServerId,
            workspacePath: "/",
          }),
        )!,
        sourceServerId: device.sourceServerId,
        label: device.displayName,
        status: statuses.get(device.sourceServerId) ?? "offline",
      }))
    : directory.hosts.map((host) => ({
        id: host.id,
        label: remoteHostLabel(host),
        status: host.connectionStatus ?? "offline",
      }));
  const prepareHost = async (hostId: string, isCurrent = () => active.current) => {
    if (hostId === "local") return;
    const current = (await remoteService.readDirectory()).hosts.find((host) => host.id === hostId);
    if (!active.current || !isCurrent()) throw new Error("project.creation-cancelled");
    const previous = admittedHosts.current.get(hostId);
    if (previous && previous.membershipId !== current?.membershipId)
      throw new Error("remote-project.host-removed");
    if (current) {
      admittedHosts.current.set(hostId, current);
      return current;
    }
    const device = devices.find((item) => item.id === hostId);
    const source = snapshotRef.current?.servers.find(
      (item) => item.sourceServerId === device?.sourceServerId,
    );
    const profile =
      source &&
      snapshotRef.current?.profiles.find(
        (item) =>
          item.lifecycleState !== "retired" && item.sourceServerId === source.sourceServerId,
      );
    if (!profile) throw new Error("project.connection-unavailable");
    // 已识别设备不一定有项目成员；只在显式创建或选择已有项目时登记，浏览设备/列表不写入口。
    const host = await remoteService.saveHost({ id: hostId, target: profile.target });
    if (!active.current || !isCurrent()) throw new Error("project.creation-cancelled");
    admittedHosts.current.set(hostId, host);
    return host;
  };
  const saved = async (project: VirtualProject) => {
    if (!active.current) return;
    if (project.hostId !== "local") {
      const host = admittedHosts.current.get(project.hostId);
      if (!host) throw new Error("remote-project.host-removed");
      await remoteService.addEntry({
        hostId: project.hostId,
        expectedMembershipId: host.membershipId,
        project: { projectId: project.id, name: project.name, roots: project.roots },
      });
      if (!active.current) return;
      sidebar?.preferences.prepend(project);
    }
    await onSaved();
    const draft = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspacePath, workspaceIdentity);
    // 创建原来只刷新列表，草稿仍绑定旧项目；复用项目选择入口，并拒绝保存期间已失效的草稿。
    if (
      active.current &&
      currentScope.current.activeTabId === originTabId.current &&
      currentScope.current.workspaceKey === originDraft.workspaceKey &&
      !originDraft.activeTaskId &&
      !draft.activeTaskId &&
      draft.draftFocusVersion === originDraft.draftFocusVersion &&
      draft.draftProjectId === originDraft.draftProjectId
    ) {
      logger.debug("[ProjectCreation] select created project for draft", {
        projectId: project.id,
        hostId: project.hostId,
      });
      onCreateTask({
        projectId: project.id,
        hostId: project.hostId,
        taskGroupId: draft.draftTaskGroupId ?? null,
        initialComposerDraft: captureV4ComposerDraftHandoff(
          workspacePath,
          workspaceIdentity,
          composerClientNamespace,
        ),
      });
    }
  };
  const connectDevice = async (device: ProjectDevice): Promise<boolean> => {
    if (allowDeviceManagement && onOpenRemoteWorkspace) {
      return new Promise((resolve) => {
        const request = { device, resolve };
        pendingConnection.current = request;
        setConnection(request);
        const accepted = onOpenRemoteWorkspace({
          completion: "device-management",
          preferredSourceServerId: device.sourceServerId,
          returnTarget: {
            kind: "connect-device",
            isCurrent: () => active.current && pendingConnection.current === request,
            finish: (result) => {
              if (!active.current || pendingConnection.current !== request) return;
              pendingConnection.current = null;
              setConnection(null);
              // 原目录/已有项目 continuation 只接受所选 Source，不能被向导改选线路串写。
              resolve(
                result.kind === "connected" && result.sourceServerId === device.sourceServerId,
              );
            },
          },
        });
        if (accepted === false) {
          pendingConnection.current = null;
          setConnection(null);
          resolve(false);
        }
      });
    }
    const host = await remoteService.connectHost(device.id);
    if (!active.current) return false;
    admittedHosts.current.set(host.id, host);
    return true;
  };
  return (
    <>
      <ProjectEditor
        project={null}
        projects={projects}
        service={service}
        devices={devices}
        defaultDeviceId={defaultDeviceId}
        onClose={onClose}
        onSaved={saved}
        onBeforeSave={async (hostId) => {
          await prepareHost(hostId);
        }}
        remoteService={remoteService}
        onSavedExisting={async (isCurrent) => {
          await onSaved();
          if (active.current && isCurrent?.()) onClose();
        }}
        onPrepareExisting={async (hostId, isCurrent) => {
          const host = await prepareHost(hostId, isCurrent);
          if (!host) throw new Error("remote-project.host-removed");
          return host;
        }}
        onBrowseExisting={(device) =>
          device.status === "online" ? Promise.resolve(true) : connectDevice(device)
        }
        // 后台取消只解除连接等待，原草稿在用户回到原 tab 前仍保持隐藏。
        suspended={Boolean(connection) || addingDevice || activeTabId !== originTabId.current}
        onConnectDevice={connectDevice}
        onAddDevice={
          allowDeviceManagement && onOpenRemoteWorkspace
            ? (selectDevice) => {
                const request = {};
                addition.current = request;
                setAddingDevice(true);
                const accepted = onOpenRemoteWorkspace({
                  completion: "device-management",
                  returnTarget: {
                    kind: "add-device",
                    isCurrent: () => active.current && addition.current === request,
                    finish: async (result) => {
                      if (!active.current || addition.current !== request) return;
                      addition.current = null;
                      setAddingDevice(false);
                      if (result.kind === "connected" && result.sourceServerId) {
                        // 返回仍走同一个设备切换入口，不能绕过原草稿的目录确认。
                        await selectDevice(
                          remoteHostIdFromWorkspaceIdentity(
                            buildServerRemoteWorkspaceIdentity({
                              serverId: result.sourceServerId,
                              workspacePath: "/",
                            }),
                          )!,
                        );
                      }
                    },
                  },
                });
                if (accepted === false) {
                  addition.current = null;
                  setAddingDevice(false);
                }
              }
            : undefined
        }
      />
    </>
  );
}
