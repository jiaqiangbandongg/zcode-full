import {
  SidebarNativeTooltip,
  SidebarTooltipProvider,
  ControlHintTooltip,
} from "@/ControlHintTooltip.js";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { GroupedDraftTaskRow } from "@/project-sidebar/grouped/draft-task-row.js";
import { GroupedTaskRow } from "@/project-sidebar/grouped/task-row.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu.js";
import { Button } from "@/components/ui/button.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.className = `${theme} theme-zai-${theme}`;
const noop = () => {};
Object.assign(window, {
  __renderFixture: { services: {}, tabStore: { getState: () => ({ tabs: [] }) } },
});

function Fixture() {
  const [clicks, setClicks] = useState(0);
  return (
    <div className="flex flex-col gap-8 p-8 bg-background text-foreground min-h-screen">
      <SidebarNativeTooltip>
        <button title="Outside native" data-testid="outside-native">
          Outside native
        </button>
      </SidebarNativeTooltip>
      <ControlHintTooltip title="Outside tooltip">
        <button data-testid="outside-tooltip">Outside tooltip</button>
      </ControlHintTooltip>
      <SidebarTooltipProvider>
        <div className="flex w-64 max-w-full flex-col gap-4" data-testid="details-sidebar">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarNativeTooltip>
                <Button
                  title="File menu"
                  data-testid="native-menu"
                  onPointerDown={() => setClicks((n) => n + 1)}
                >
                  File menu
                </Button>
              </SidebarNativeTooltip>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => setClicks((n) => n + 1)}>
                Open folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <SidebarNativeTooltip>
            <Button disabled title="Unavailable folder" data-testid="disabled-native">
              Disabled
            </Button>
          </SidebarNativeTooltip>
          <TooltipProvider>
            <ControlHintTooltip title="Nested hint">
              <Button data-testid="nested-tooltip">Nested</Button>
            </ControlHintTooltip>
          </TooltipProvider>
          <GroupedDraftTaskRow
            active
            workspaceLabel="Draft folder"
            onSelect={noop}
            onClose={noop}
          />
          <GroupedTaskRow
            task={{
              taskId: "fixture",
              hostId: "local",
              workspacePath: "/example",
              title: "Grouped task",
              traceId: "fixture",
              mode: "build",
              projectId: "project",
              pinned: false,
              archived: false,
              createdAt: 1,
              updatedAt: 2,
            }}
            groups={[]}
            activeWorkspacePath="/example"
            activeTaskId={null}
            workspaceLabel="Grouped folder"
            onSelectTask={noop}
            onCloseTask={noop}
            onOpenFileTree={noop}
            onMoveTaskToGroup={noop}
            onMoveTaskToTop={noop}
            onStartRenameTask={noop}
            onArchiveTask={noop}
            onMarkTaskAsUnread={noop}
          />
          <output data-testid="clicks">{clicks}</output>
        </div>
      </SidebarTooltipProvider>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
