import { createRoot } from "react-dom/client";
import { projectKey } from "@/project-sidebar/view.js";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import { ProjectComposerMenu } from "@/project-sidebar/ProjectComposerMenu.js";
import type { ProjectNodeProps } from "@/project-sidebar/ProjectNodeContent.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "light";
const locale = params.get("locale") === "zh-CN" ? "zh-CN" : "en-US";
document.documentElement.className = `${theme} theme-zai-${theme}`;
document.documentElement.style.setProperty("--ui-font-size", `${params.get("font") ?? 14}px`);
const noop = () => {};
const project: ProjectNodeProps["project"] = {
  id: "project",
  hostId: "remote:server:source",
  name: params.get("name") ?? "dev",
  roots: [{ rootPath: "/example", position: 0, isPrimary: true }],
  deleted: false,
  pinned: false,
  nameOverridden: true,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
};
const host: ProjectNodeProps["remoteHost"] = {
  id: project.hostId,
  membershipId: "member",
  kind: "ssh",
  target: { kind: "ssh", host: "example.test", username: "dev", port: 22 },
  connectionStatus: "online",
  lastConnectionStatus: "online",
  position: 0,
};
const deviceLabel = params.get("device") ?? "DEV-TEST · dev";
// 只注入目录事实；项目行、菜单、图标与字体均使用生产组件。
Object.assign(window, {
  __projectDeviceDirectory: {
    tree: { projects: [project], tasks: [] },
    projects: [project],
    availability: new Map([[projectKey(project), { online: true, entryId: "entry" }]]),
    directory: { hosts: [host] },
    deviceNames: new Map([["source", deviceLabel]]),
    loading: false,
    error: null,
    service: {},
    remoteService: {},
    refresh: async () => {},
  },
});
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <TooltipProvider>
      <main className="min-h-screen bg-background p-4 text-foreground">
        <section className="w-64 max-w-full bg-sidebar" aria-label="Sidebar">
          <ProjectNode
            project={project}
            remoteHost={host}
            deviceLabel={deviceLabel}
            expanded={false}
            onExpandedChange={noop}
            tasks={[]}
            onCreate={noop}
            onEdit={noop}
            onDelete={noop}
            onPin={noop}
            onMove={noop}
            onSelect={noop}
            refresh={async () => {}}
          />
        </section>
        <div className="mt-8">
          <ProjectComposerMenu
            workspacePath="/example"
            compactForRemoteControl={params.get("mobile") === "1"}
            onCreateTask={noop}
            onSelectConversationWorkspace={noop}
          />
        </div>
      </main>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
