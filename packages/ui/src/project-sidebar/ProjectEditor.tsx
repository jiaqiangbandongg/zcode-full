import { formatProjectError } from "@/project-sidebar/view.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Folder,
  FolderPlus,
  LoaderCircle,
  Monitor,
  Plus,
  Server,
  X,
} from "lucide-react";
import type {
  IProjectService,
  VirtualProject,
  RemoteProjectHost,
  ProjectDevice,
} from "@/project-sidebar/contract.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Input } from "@/components/ui/input.js";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import { useRemoteBoundaryAcknowledgement } from "@/RemoteConnectionDialogContent.js";
import { useProjectDirectoryServices } from "@/project-sidebar/useProjectDirectoryServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { RemoteProjectList } from "@/project-sidebar/RemoteProjectList.js";
import type { IRemoteProjectService } from "@/project-sidebar/contract.js";
import { logger } from "@/logger.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import {
  resolveRemoteConnectionPresentation,
  type RemoteConnectionStatus,
} from "@/lib/remoteConnectionPresentation.js";
import {
  ProjectFolderTrustDialog,
  type ProjectFolderTrustRequest,
} from "@/project-sidebar/ProjectFolderTrustDialog.js";

const FIELD_LABEL = "text-ui-sm font-medium text-foreground";
// SelectItem 的 ItemText 默认按内容收缩；撑满整行后状态才能靠右，长名称截断时不挤掉状态。
const DEVICE_ITEM = "pr-8 *:[span]:last:min-w-0 *:[span]:last:flex-1";

/** 设备行：图标 + 名称 + 状态；状态颜色只取远程连接展示模型，在线只留圆点。 */
function DeviceOption({ label, status }: { label: string; status?: string }) {
  const { intl } = useZCodeIntl();
  const presentation = status
    ? resolveRemoteConnectionPresentation({ state: status as RemoteConnectionStatus })
    : undefined;
  const Icon = status ? Server : Monitor;
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <Icon className="size-4 text-foreground-subtle" />
      <span className="min-w-0 truncate">{label}</span>
      {presentation ? (
        <span
          data-testid="virtual-project-device-status"
          data-status={status}
          className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle"
        >
          {presentation.icon === "spinner" ? (
            <LoaderCircle className={`size-3 animate-spin ${presentation.foreground}`} />
          ) : (
            <span className={`size-2 rounded-full ${presentation.dot}`} />
          )}
          <span className={status === "online" ? "sr-only" : undefined}>
            {intl.formatMessage({ id: `project.deviceStatus.${status}` })}
          </span>
        </span>
      ) : null}
    </span>
  );
}

export function ProjectEditor({
  project,
  host,
  initialRoots = [],
  fixedFolder,
  isCurrent = () => true,
  projects,
  service,
  onClose,
  onSaved,
  onDeleted,
  devices,
  defaultDeviceId,
  suspended = false,
  onBeforeSave,
  onConnectDevice,
  onAddDevice,
  remoteService,
  onBrowseExisting,
  onPrepareExisting,
  onSavedExisting = async () => undefined,
}: {
  project: VirtualProject | null;
  remoteService?: IRemoteProjectService;
  onSavedExisting?(isCurrent?: () => boolean): Promise<void>;
  onBrowseExisting?(device: ProjectDevice): Promise<boolean>;
  onPrepareExisting?(hostId: string, isCurrent: () => boolean): Promise<RemoteProjectHost>;
  devices?: ProjectDevice[];
  defaultDeviceId?: string;
  suspended?: boolean;
  onBeforeSave?(hostId: string): Promise<void>;
  onConnectDevice?(device: ProjectDevice): Promise<boolean>;
  onAddDevice?(selectDevice: (id: string) => Promise<void>): void;
  host?: RemoteProjectHost;
  initialRoots?: string[];
  /** 聊天已确认的远程目录；表单不能改成另一个 Host 或 root。 */
  fixedFolder?: { hostId: string; path: string; deviceLabel: string };
  isCurrent?(): boolean;
  projects: VirtualProject[];
  service: IProjectService;
  onClose(): void;
  onSaved(project: VirtualProject): Promise<void>;
  onDeleted?(): Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const sidebar = useOptionalProjectDirectory();
  const platform = useOptionalPlatform();
  const [selectedDeviceId, setSelectedDeviceId] = useState(defaultDeviceId ?? "local");
  const hostId =
    project?.hostId ?? fixedFolder?.hostId ?? host?.id ?? (devices ? selectedDeviceId : undefined);
  const remote = Boolean(hostId && hostId !== "local");
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  const [name, setName] = useState(
    project?.name ?? (fixedFolder ? getPathLeaf(fixedFolder.path) : ""),
  );
  const [nameEdited, setNameEdited] = useState(false);
  const [roots, setRoots] = useState(
    project?.roots.map((root) => root.rootPath) ??
      (fixedFolder ? [fixedFolder.path] : initialRoots),
  );
  const [primary, setPrimary] = useState(
    project?.roots.find((root) => root.isPrimary)?.rootPath ??
      fixedFolder?.path ??
      initialRoots[0] ??
      "",
  );
  const [existing, setExisting] = useState(false);
  const [legacyDeviceId, setLegacyDeviceId] = useState<string | null>(null);
  const existingButton = useRef<HTMLButtonElement>(null);
  const [browsing, setBrowsing] = useState(false);
  const directory = useProjectDirectoryServices(service, hostId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<VirtualProject | null>(null);
  const [folderTrust, setFolderTrust] = useState<ProjectFolderTrustRequest | null>(null);
  const saveFlight = useRef<{ cancelTrust?: () => void } | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const confirm = useConfirmDialog();
  const acknowledgeBoundary = useRemoteBoundaryAcknowledgement();
  const epoch = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
      saveFlight.current?.cancelTrust?.();
    };
  }, []);
  useEffect(() => {
    // 父表单切到后台后，连同尚未完成的恢复查询一起失效，避免返回前台后旧查询重新弹出确认。
    if (suspended && saveFlight.current) {
      epoch.current++;
      saveFlight.current.cancelTrust?.();
    }
  }, [suspended]);
  const current = (request: number) => alive.current && epoch.current === request;
  const selectedDevice = devices?.find((device) => device.id === selectedDeviceId);
  const changeDevice = async (next: string) => {
    if (next === selectedDeviceId) return;
    const request = ++epoch.current;
    // 确认前不提交任何字段；旧目录响应也随此次设备选择失效，避免跨设备污染草稿。
    if (
      roots.length &&
      !(await confirm({ title: msg("switchDevice"), description: msg("switchDeviceDescription") }))
    )
      return;
    if (!current(request)) return;
    setRoots([]);
    setPrimary("");
    setBrowsing(false);
    setError(null);
    setSelectedDeviceId(next);
  };
  const addRoots = (values: string[]) => {
    if (remote && project) return;
    const next = remote
      ? values.filter(Boolean).slice(0, 1)
      : [...new Set([...roots, ...values.filter(Boolean)])];
    setRoots(next);
    if (remote || !roots.length) setPrimary(next[0] ?? "");
    setBrowsing(false);
  };
  const browse = async () => {
    const request = ++epoch.current;
    if (remote && devices && selectedDevice?.status !== "online") {
      if (!selectedDevice || !onConnectDevice) {
        setError(msg("connectionUnavailable"));
        return;
      }
      setBusy(true);
      try {
        const ready = await onConnectDevice(selectedDevice);
        if (current(request) && ready) setBrowsing(true);
      } catch (cause) {
        if (current(request)) setError(formatProjectError(cause, intl.formatMessage));
      } finally {
        if (current(request)) setBusy(false);
      }
      return;
    }
    // 本地曾统一走 Host 文件列表，绕过系统多选；按项目 Host 与平台能力选入口，不能借当前 tab 判定。
    if ((hostId && hostId !== "local") || !platform?.selectDirectories) {
      if (remote) {
        setBusy(true);
        try {
          // 已连接设备可直接浏览目录，仍须经过与主动连接相同的首次介绍；失效表单不记已读。
          if (!(await acknowledgeBoundary(() => current(request) && !suspendedRef.current))) return;
        } finally {
          if (current(request)) setBusy(false);
        }
      }
      if (current(request) && !suspendedRef.current) setBrowsing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const selected = await platform.selectDirectories();
      logger.debug("[ProjectEditor] native directory selection", { count: selected.length });
      if (current(request) && selected.length) addRoots(selected);
    } catch (cause) {
      logger.warn("[ProjectEditor] native directory selection failed", cause);
      if (current(request)) setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      if (current(request)) setBusy(false);
    }
  };
  const save = async () => {
    if (saveFlight.current || suspendedRef.current || !isCurrent()) return;
    const flight: { cancelTrust?: () => void } = {};
    saveFlight.current = flight;
    const request = epoch.current;
    const canCommit = () => current(request) && !suspendedRef.current && isCurrent();
    setBusy(true);
    setError(null);
    try {
      if (created) {
        await onSaved(created);
        if (canCommit()) onClose();
        return;
      }
      if (remote && (roots.length !== 1 || (project && project.roots[0]?.rootPath !== roots[0]))) {
        throw new Error("project.remote-single-root-required");
      }
      let restoreProject: VirtualProject | undefined;
      if (!project) {
        // 设备全集不等于本机项目入口全集；远端恢复候选必须读取所属 Host，不能只看 open set。
        const tree =
          remote && (devices || fixedFolder)
            ? await service.readTree({ hostId, includeDeleted: true })
            : undefined;
        if (tree?.legacySingleRoot) {
          setLegacyDeviceId(hostId!);
          throw new Error(msg("legacyUpgradeRequired"));
        }
        const candidates = tree?.projects ?? projects;
        if (!canCommit()) return;
        const deleted = candidates.find(
          (candidate) =>
            candidate.deleted &&
            (!hostId || candidate.hostId === hostId) &&
            candidate.roots.length === roots.length &&
            candidate.roots.every((root) => roots.includes(root.rootPath)),
        );
        if (
          deleted &&
          (await confirm({
            title: msg("restore"),
            description: intl.formatMessage(
              { id: "project.restoreDescription" },
              { name: deleted.name },
            ),
          }))
        )
          restoreProject = deleted;
      }
      if (!canCommit()) return;
      if (!project && roots.length) {
        const accepted = await new Promise<boolean>((resolve) => {
          const finish = (value: boolean) => {
            if (!flight.cancelTrust) return;
            flight.cancelTrust = undefined;
            if (alive.current) setFolderTrust(null);
            resolve(value);
          };
          flight.cancelTrust = () => finish(false);
          setFolderTrust({
            roots: [...roots],
            deviceLabel: remote
              ? (fixedFolder?.deviceLabel ??
                selectedDevice?.label ??
                (host ? remoteHostLabel(host) : hostId!))
              : undefined,
            restoring: Boolean(restoreProject),
            projectName: fixedFolder
              ? (nameEdited ? name.trim() : restoreProject?.name) || getPathLeaf(fixedFolder.path)
              : undefined,
            resolve: finish,
          });
        });
        logger.debug("[ProjectEditor] folder confirmation", {
          accepted,
          remote,
          count: roots.length,
        });
        if (!accepted || !canCommit()) return;
      }
      await onBeforeSave?.(hostId ?? "local");
      if (!canCommit()) return;
      const saved = await service.saveProject({
        ...(hostId ? { hostId } : {}),
        ...(project ? { id: project.id } : {}),
        ...(restoreProject ? { restoreProjectId: restoreProject.id } : {}),
        ...(nameEdited ? { name: name.trim() } : {}),
        defaultName: msg("new"),
        roots,
        ...(primary ? { primaryRoot: primary } : {}),
      });
      if (!alive.current) return;
      // 远端创建与本机入口登记分两步；登记失败重试必须复用已创建的项目，不能再生成一个 ID。
      if (!project) setCreated(saved);
      // 外层聊天可能已换代；保留已保存结果，但不继续登记、导航或关闭新流程。
      if (!canCommit()) return;
      if (!project && !remote) sidebar?.preferences.prepend(saved);
      await onSaved(saved);
      // 草稿可能已被关闭或替换；旧登记结果不能关闭后来创建的表单。
      if (canCommit()) onClose();
    } catch (cause) {
      if (canCommit()) setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      if (saveFlight.current === flight) saveFlight.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const remove = async () => {
    if (!project) return;
    setBusy(true);
    setError(null);
    try {
      // 编辑器曾漏掉删除入口；复用所属 Host 的软删除，不触碰文件或任务。
      await service.deleteProject(project.id, project.hostId);
      await onDeleted?.();
      onClose();
    } catch (cause) {
      setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      setBusy(false);
    }
  };
  const browseExisting = async () => {
    if (!selectedDevice || !onBrowseExisting) return;
    const request = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      if ((await onBrowseExisting(selectedDevice)) && current(request)) setExisting(true);
    } catch (cause) {
      if (current(request)) setError(formatProjectError(cause, intl.formatMessage));
    } finally {
      if (current(request)) setBusy(false);
    }
  };
  const browserEpoch = epoch.current;
  const needsConnection = remote && Boolean(devices) && selectedDevice?.status !== "online";
  return (
    <Dialog
      open={!suspended}
      onOpenChange={(open) => {
        if (!open)
          logger.debug("[ProjectEditor] close requested", {
            busy,
            confirming: Boolean(folderTrust),
          });
        if (!open && (!busy || fixedFolder)) onClose();
      }}
    >
      <DialogContent
        className="max-w-lg gap-5"
        onKeyDown={fixedFolder ? (event) => event.stopPropagation() : undefined}
      >
        {existing && selectedDevice && remoteService ? (
          <RemoteProjectList
            key={selectedDevice.id}
            embedded
            device={selectedDevice}
            service={service}
            remoteService={remoteService}
            onBeforeAdd={(isCurrent) => onPrepareExisting!(selectedDevice.id, isCurrent)}
            onLegacyCapability={(legacy) => setLegacyDeviceId(legacy ? selectedDevice.id : null)}
            onSaved={async (isCurrent) => {
              await onSavedExisting(isCurrent);
            }}
            onClose={() => {
              epoch.current++;
              setExisting(false);
              requestAnimationFrame(() => existingButton.current?.focus());
            }}
          />
        ) : (
          <>
            <DialogTitle>
              {browsing ? msg("browse") : project ? msg("edit") : msg("create")}
            </DialogTitle>
            <DialogDescription className="sr-only">{msg("description")}</DialogDescription>
            {browsing ? (
              <div
                className="flex h-96 min-h-0 flex-col gap-2"
                data-testid="virtual-project-directory-browser"
              >
                <DirectoryBrowser
                  embedded
                  showSelectionActions
                  selectLabel={msg("browse")}
                  services={directory.services}
                  onSelect={(path) => {
                    if (current(browserEpoch)) addRoots([path]);
                  }}
                  onCancel={() => {
                    epoch.current++;
                    setBrowsing(false);
                  }}
                />
              </div>
            ) : (
              <>
                <div className="grid min-w-0 gap-1.5">
                  <label htmlFor="project-name" className={FIELD_LABEL}>
                    {msg("name")}
                  </label>
                  <Input
                    id="project-name"
                    aria-label={msg("name")}
                    placeholder={msg("new")}
                    autoFocus
                    disabled={busy || Boolean(created)}
                    data-testid="virtual-project-name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setNameEdited(true);
                    }}
                    className="h-9 rounded-lg max-md:text-mobile-input-safe"
                  />
                  {fixedFolder ? (
                    <p className="break-all text-ui-sm text-foreground-subtle">
                      {fixedFolder.deviceLabel}
                    </p>
                  ) : null}
                </div>
                {devices ? (
                  <div className="grid min-w-0 gap-1.5">
                    <label htmlFor="project-device" className={FIELD_LABEL}>
                      {msg("device")}
                    </label>
                    <Select
                      value={selectedDeviceId}
                      onValueChange={(value) => {
                        if (value === "add-device") onAddDevice?.(changeDevice);
                        else void changeDevice(value);
                      }}
                      disabled={busy || Boolean(created)}
                    >
                      <SelectTrigger
                        id="project-device"
                        data-testid="virtual-project-device"
                        className="h-9 w-full min-w-0 rounded-lg *:data-[slot=select-value]:w-full *:data-[slot=select-value]:min-w-0"
                      >
                        <SelectValue>
                          <DeviceOption
                            label={
                              selectedDeviceId === "local"
                                ? msg("thisComputer")
                                : (selectedDevice?.label ?? selectedDeviceId)
                            }
                            status={
                              selectedDeviceId === "local"
                                ? undefined
                                : (selectedDevice?.status ?? "offline")
                            }
                          />
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent position="popper" className="w-(--radix-select-trigger-width)">
                        <SelectItem value="local" data-device-id="local" className={DEVICE_ITEM}>
                          <DeviceOption label={msg("thisComputer")} />
                        </SelectItem>
                        {devices.map((device) => (
                          <SelectItem
                            key={device.id}
                            value={device.id}
                            data-device-id={device.id}
                            className={DEVICE_ITEM}
                          >
                            <DeviceOption label={device.label} status={device.status} />
                          </SelectItem>
                        ))}
                        {onAddDevice ? (
                          <>
                            <SelectSeparator />
                            <SelectItem value="add-device">
                              <Plus className="text-foreground-subtle" />
                              {msg("addRemoteDevice")}
                            </SelectItem>
                          </>
                        ) : null}
                      </SelectContent>
                    </Select>
                    {/* 旧入口是一行 ghost 文字，用户看不出可点也不知用途；改为挨着设备的问句 + 下划线链接。 */}
                    {remote && selectedDevice && onBrowseExisting ? (
                      <p className="flex flex-wrap items-center gap-x-1 text-ui-sm text-foreground-subtle">
                        {msg("existingOnDeviceHint")}
                        <button
                          ref={existingButton}
                          type="button"
                          disabled={busy || Boolean(created)}
                          data-testid="virtual-project-existing"
                          className="inline-flex items-center gap-0.5 rounded-sm text-brand underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
                          onClick={() => void browseExisting()}
                        >
                          {msg("existingOnDeviceAction")}
                          <ChevronRight className="size-3.5" />
                        </button>
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <fieldset disabled={busy || Boolean(created)} className="min-w-0">
                  <legend className={`mb-1.5 ${FIELD_LABEL}`}>{msg("folders")}</legend>
                  {/* 有目录时使用同一列表的末行添加，只有零目录才展示空态大卡片。 */}
                  <div
                    data-testid={roots.length ? "virtual-project-roots" : undefined}
                    className={
                      roots.length
                        ? "min-w-0 overflow-hidden rounded-lg border border-border divide-y divide-border"
                        : undefined
                    }
                  >
                    {roots.map((root) => (
                      <div
                        className="flex min-h-12 min-w-0 items-center gap-2 px-3 py-2"
                        key={root}
                        data-testid="virtual-project-root-row"
                      >
                        <Folder className="size-4 shrink-0 text-foreground-subtle" />
                        <span
                          className={
                            fixedFolder
                              ? "min-w-0 flex-1 break-all text-ui-base"
                              : "min-w-0 flex-1 truncate text-ui-base"
                          }
                          title={root}
                          data-testid="virtual-project-root-name"
                        >
                          {fixedFolder ? root : getPathLeaf(root)}
                        </span>
                        {root === primary ? (
                          <span
                            data-testid="virtual-project-primary"
                            className="inline-flex h-7 shrink-0 items-center rounded-md border border-border px-2 text-ui-base text-foreground-subtle"
                          >
                            {msg("primaryBadge")}
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-foreground-subtle"
                            data-testid="virtual-project-set-primary"
                            onClick={() => setPrimary(root)}
                          >
                            {msg("setPrimary")}
                          </Button>
                        )}
                        {!fixedFolder && (!remote || !project) ? (
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-foreground-subtle"
                            data-testid="virtual-project-remove-folder"
                            aria-label={msg("removeFolder")}
                            onClick={() => {
                              const next = roots.filter((item) => item !== root);
                              setRoots(next);
                              if (primary === root) setPrimary(next[0] ?? "");
                            }}
                          >
                            <X className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    {!fixedFolder && (!remote || !project) ? (
                      <button
                        type="button"
                        data-testid="virtual-project-browse"
                        aria-label={msg(needsConnection ? "connectAndBrowse" : "browse")}
                        className={`group flex w-full items-center gap-2 text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30 ${roots.length ? "min-h-12 px-3 py-2 text-left" : "min-h-32 flex-col justify-center rounded-lg border border-dashed border-border px-4 py-5 text-center hover:border-border-hover"}`}
                        onClick={() => {
                          void browse();
                        }}
                      >
                        {roots.length ? (
                          <>
                            <FolderPlus className="size-4 shrink-0 text-foreground-subtle" />
                            <span>
                              {msg(needsConnection ? "connectAndBrowse" : "addSourceFolder")}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="flex size-9 items-center justify-center rounded-full bg-surface text-foreground-subtle group-hover:text-foreground">
                              <FolderPlus className="size-4" />
                            </span>
                            <span className="font-medium">
                              {msg(needsConnection ? "connectAndBrowse" : "browse")}
                            </span>
                            <span className="text-ui-sm text-foreground-subtle">
                              {needsConnection
                                ? intl.formatMessage(
                                    { id: "project.connectAndBrowseHint" },
                                    {
                                      status: msg(
                                        `deviceStatus.${selectedDevice?.status ?? "offline"}`,
                                      ),
                                    },
                                  )
                                : msg("browseHint")}
                            </span>
                          </>
                        )}
                      </button>
                    ) : null}
                  </div>
                </fieldset>
                {legacyDeviceId === hostId ? (
                  <p className="text-ui-sm text-foreground-subtle">
                    {msg("legacyUpgradeRequired")}
                  </p>
                ) : null}
                {error ? (
                  <p role="alert" className="text-ui-sm text-destructive">
                    {error}
                  </p>
                ) : null}
                <DialogFooter className="flex-row flex-wrap items-center justify-end">
                  {project ? (
                    <Button
                      variant="ghost"
                      data-testid="virtual-project-editor-delete"
                      disabled={busy || Boolean(created)}
                      onClick={() => {
                        void remove();
                      }}
                      className="mr-auto bg-destructive-surface text-destructive-surface-foreground hover:bg-destructive-surface hover:text-destructive-surface-foreground"
                    >
                      {msg("delete")}
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={onClose} disabled={busy && !fixedFolder}>
                    {msg("cancel")}
                  </Button>
                  <Button
                    ref={saveButton}
                    data-testid="virtual-project-save"
                    onClick={() => {
                      void save();
                    }}
                    disabled={busy || (remote && (roots.length !== 1 || legacyDeviceId === hostId))}
                  >
                    {project ? msg("save") : msg("create")}
                  </Button>
                </DialogFooter>
              </>
            )}
          </>
        )}
        {/* 确认框须留在父弹层的 React 树内；兄弟节点的触摸取消会被延迟判为外部点击，连带关闭草稿。 */}
        {folderTrust && !suspended ? (
          <ProjectFolderTrustDialog
            request={folderTrust}
            onClosed={() => {
              if (alive.current && !suspendedRef.current) saveButton.current?.focus();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
