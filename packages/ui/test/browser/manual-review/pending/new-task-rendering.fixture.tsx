import { useState } from "react";
import { Event, ProxyChannel } from "@zcode/rpc";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ChatLoading } from "@/components/ai-elements/chat-loading.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  ProjectDirectoryProvider,
  ProjectSidebar,
  useOptionalProjectDirectory,
} from "@/project-sidebar/index.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ProjectTree, ProjectSidebarProps } from "@/project-sidebar/contract.js";
import type { IServiceAccessor } from "@zcode/services";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const mobile = params.get("mobile") === "1";
const activity = params.get("activity") === "1";
const tooltips = params.get("tooltips") === "1";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const noop = () => {};
const activate = () => true;
const dispose = () => ({ dispose: noop });
const tree: ProjectTree = {
  projects: Array.from({ length: 44 }, (_, index) => ({
    id: `p${index}`,
    hostId: "local",
    name: `Project ${index}`,
    roots: tooltips ? [{ rootPath: "/example", position: 0 }] : [],
    pinned: false,
    deleted: false,
    position: index,
    createdAt: 1,
    updatedAt: 1,
    nameOverridden: true,
  })),
  tasks: activity
    ? [
        {
          taskId: "running-task",
          workspacePath: "/example",
          hostId: "local",
          projectId: "p0",
          title: "Running task",
          createdAt: 1,
          updatedAt: 1,
          pinned: false,
          archived: false,
        },
      ]
    : [],
};
let activitySnapshot = {
  items: activity
    ? [
        attachTaskListRowActivity(tree.tasks[0]!, {
          phase: "running",
          lastActivityAt: 1,
          hasBackgroundWork: false,
        }),
      ]
    : [],
};
const activityListeners = new Set<() => void>();
const activityStore = {
  getSnapshot: () => activitySnapshot,
  subscribe: (listener: () => void) => {
    activityListeners.add(listener);
    return () => activityListeners.delete(listener);
  },
  update: (complete = false) => {
    activitySnapshot = {
      items: [
        attachTaskListRowActivity(tree.tasks[0]!, {
          phase: complete ? "completedSuccess" : "running",
          lastActivityAt: activitySnapshot.items[0]!.__zcodeSessionActivity.lastActivityAt + 1,
          hasBackgroundWork: false,
        }),
      ],
    };
    activityListeners.forEach((listener) => listener());
  },
};
const tabState = {
  tabs: [],
  activeWorkspacePath: "/example",
  activeWorkspaceIdentity: null,
  openSettingsTab: noop,
};
const tabStore = { getState: () => tabState, subscribe: () => noop };
const services = {
  credentialService: ProxyChannel.toService({
    call: async <T,>() => null as T,
    listen: () => Event.None,
  }),
  settingService: { get: async () => ({}), update: async () => {} },
  projectService: {
    readTree: async () => structuredClone(tree),
    saveProject: async (input: { id: string; pinned: boolean }) => {
      tree.projects.find((project) => project.id === input.id)!.pinned = input.pinned;
    },
    prepareSession: async () => ({
      workspacePath: "/example",
      projectId: null,
      additionalDirectories: [],
    }),
  },
  remoteProjectService: { readDirectory: async () => ({ hosts: [], entries: [] }) },
  broadcastService: { onMessage: dispose },
  zcodeTaskService: { onDynamicWorkspaceEvent: () => dispose },
} as unknown as IServiceAccessor;
Object.assign(window, { __renderFixture: { services, tabStore, activityStore } });
useZCodeSessionStore.getState().setActiveTaskId("/example", "old-session");
const common = {
  workspacePath: "/example",
  theme,
  isDesktop: !mobile,
  isWebRemoteControl: mobile,
  onSelectTask: noop,
  onStartDraftInWorkspace: noop,
  onOpenFolderFromWorkspaceMenu: noop,
  onConnectRemote: async () => "remote",
  onSelectRemoteProject: async () => {},
  onCancelRemoteProject: async () => {},
  onReconnectRemoteWorkspace: async () => {},
  reconnectingRemoteWorkspaceKeys: [],
  remoteWorkspaceErrorByWorkspaceKey: {},
  onOpenCommandCenter: noop,
} satisfies Omit<ProjectSidebarProps, "onCreateTask">;
const actions = {
  intl: { formatMessage: ({ id }: { id: string }) => id } as never,
  platform: {
    onRemoteConnectionLog: () => noop,
    onRemoteSessionClosed: () => noop,
    onRemoteSessionReconnected: () => noop,
  } as never,
  services,
  tabStoreApi: tabStore as never,
  addTab: noop,
  activeWorkspacePath: "/example",
  activeWorkspaceIdentity: null,
  supportsSettings: true,
  allowOpenWorkspace: true,
  preferDirectoryBrowser: false,
  refreshProviderState: async () => {},
  updateAppSettings: async () => {},
  setOAuthError: noop,
  setUser: noop,
  workbenchGroupClientMode: mobile
    ? ("web-remote-replayable" as const)
    : ("desktop-continuous" as const),
  // 手机 bridge 只模拟导航完成；Renderer 仍走实际 replayable 分支。
  openMobileProjectDraft: async () => {
    useZCodeSessionStore.getState().startDraft("/example");
  },
};
function Controls() {
  const directory = useOptionalProjectDirectory()!;
  const [refreshes, setRefreshes] = useState(0);
  const taskActivity = (
    directory.tree.tasks[0] as (typeof activitySnapshot.items)[number] | undefined
  )?.__zcodeSessionActivity;
  return (
    <>
      {activity && (
        <>
          <ChatLoading
            data-testid="fixture-chat-loading"
            loading={taskActivity?.phase === "running"}
          />
          <button data-testid="activity-tick" onClick={() => activityStore.update()}>
            Tick
          </button>
          <button data-testid="activity-complete" onClick={() => activityStore.update(true)}>
            Complete
          </button>
          <button
            data-testid="change-task"
            onClick={async () => {
              tree.tasks[0] = { ...tree.tasks[0]!, title: "Renamed task", unreadAt: 100 };
              await directory.refresh();
            }}
          >
            Change task
          </button>
          <output data-testid="activity-version">
            {
              (directory.tree.tasks[0] as (typeof activitySnapshot.items)[number])
                ?.__zcodeSessionActivity?.lastActivityAt
            }
          </output>
        </>
      )}
      <button
        data-testid="refresh-directory"
        onClick={async () => {
          await directory.refresh();
          setRefreshes((value) => value + 1);
        }}
      >
        Refresh
      </button>
      <output data-testid="refresh-count">{refreshes}</output>
      <button
        data-testid="rename-project"
        onClick={() => {
          tree.projects[0]!.name = "Renamed project";
          void directory.refresh();
        }}
      >
        Rename
      </button>
    </>
  );
}
function Fixture() {
  const [revision, setRevision] = useState(0);
  const task = useZCodeSessionStore((state) => state.workspaces["/example"]?.activeTaskId);
  // 模拟 Root 每轮装配导航实现；执行和侧栏均使用真实生产 hook/组件。
  const remote = useRemoteWorkspaceHistory({
    intl: actions.intl,
    services,
    platform: actions.platform,
    supportsSettings: false,
    isDesktop: !mobile,
    allowRemoteWorkspace: false,
    tabStoreApi: actions.tabStoreApi,
    activateTabByPath: activate,
    addTab: noop,
  });
  const navigation = useRootWorkspaceActions({
    ...actions,
    openRemoteProjectWorkspace: async () => {},
  });
  return (
    <ProjectDirectoryProvider isDesktop={!mobile}>
      <div className="flex h-screen bg-background text-foreground">
        <div className="w-64 shrink-0 bg-sidebar">
          <ProjectSidebar
            {...common}
            onCreateTask={navigation.handleCreateTask}
            onCreateConversationTask={navigation.handleCreateConversationTask}
            onSelectRemoteProject={remote.handleSelectRemoteProject}
            onReconnectRemoteWorkspace={remote.handleReconnectRemoteWorkspace}
          />
        </div>
        <main className="min-w-0 p-2 text-ui-sm">
          <output data-testid="current-task">{task ?? "draft"}</output>
          <button data-testid="shell-update" onClick={() => setRevision(revision + 1)}>
            Update {revision}
          </button>
          <Controls />
        </main>
      </div>
    </ProjectDirectoryProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
