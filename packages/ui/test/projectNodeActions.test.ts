// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render as renderWithContext, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  WORKBENCH_SESSION_DRAG_MIME,
  serializeWorkbenchSessionDragPayload,
} from "@/v4/workbenchDragDrop.js";
import type { ReactNode } from "react";
const render = (node: ReactNode) => renderWithContext(node, { wrapper: TooltipProvider });
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/project-sidebar/ProjectTaskRows.js", () => ({ ProjectTaskRows: () => null }));
afterEach(cleanup);
it("still accepts native session drops with the full workspace identity", () => {
  const props = fixture();
  const { container } = render(createElement(ProjectNode, props));
  const payload = {
    kind: "zcode/session" as const,
    workspacePath: "/repo",
    workspaceIdentity: "remote:server:one:/repo",
    sessionId: "s",
  };
  const dataTransfer = {
    types: [WORKBENCH_SESSION_DRAG_MIME],
    getData: () => serializeWorkbenchSessionDragPayload(payload),
  };
  fireEvent.drop(container.querySelector("section")!, { dataTransfer });
  expect(props.onMove).toHaveBeenCalledWith({
    workspacePath: "/repo",
    workspaceIdentity: payload.workspaceIdentity,
    taskId: "s",
  });
  expect(props.onExpandedChange).not.toHaveBeenCalled();
  expect(props.onSelect).not.toHaveBeenCalled();
});
function fixture(roots = ["/repo"]) {
  return {
    project: {
      id: "p",
      hostId: "local",
      name: "Project",
      roots: roots.map((rootPath, position) => ({ rootPath, position, isPrimary: position === 0 })),
      deleted: false,
      pinned: false,
      nameOverridden: false,
      position: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    expanded: true,
    onExpandedChange: vi.fn(),
    tasks: [],
    onCreate: vi.fn(),
    onViewFiles: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onPin: vi.fn(),
    onMove: vi.fn(),
    onSelect: vi.fn(),
    refresh: vi.fn(async () => {}),
  };
}
it("keeps the three shortcuts and updates folder state", () => {
  const props = fixture();
  const { rerender } = render(createElement(ProjectNode, props));
  const toggle = screen.getByTestId("virtual-project-toggle");
  expect(toggle.querySelector(".lucide-folder-open")).not.toBeNull();
  fireEvent.click(toggle);
  expect(props.onExpandedChange).toHaveBeenCalledWith(false);
  rerender(createElement(ProjectNode, { ...props, expanded: false }));
  expect(toggle.querySelector(".lucide-folder")).not.toBeNull();
  expect(screen.getByTestId("virtual-project-menu")).toBeDefined();
  fireEvent.click(screen.getByTestId("virtual-project-files"));
  fireEvent.click(screen.getByTestId("virtual-project-create-task"));
  expect(props.onViewFiles).toHaveBeenCalledWith("/repo");
  expect(props.onCreate).toHaveBeenCalledOnce();
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.contextMenu(toggle);
  fireEvent.click(screen.getByTestId("virtual-project-context-create-task"));
  expect(props.onCreate).toHaveBeenCalledTimes(2);
});
it("offers every root and management action from the context menu", () => {
  const props = fixture(["/one", "/two"]);
  render(createElement(ProjectNode, props));
  fireEvent.contextMenu(screen.getByTestId("virtual-project-toggle"));
  expect(screen.getByTestId("virtual-project-edit")).toBeDefined();
  expect(screen.getByTestId("virtual-project-delete")).toBeDefined();
  fireEvent.click(screen.getByTestId("virtual-project-context-files-1"));
  expect(props.onViewFiles).toHaveBeenCalledWith("/two");
});
it.each([false, true])("shows action icons for pinned=%s without replacing labels", (pinned) => {
  const props = fixture(["/one", "/two"]);
  props.project.pinned = pinned;
  render(createElement(ProjectNode, props));
  fireEvent.contextMenu(screen.getByTestId("virtual-project-toggle"));
  for (const [id, icon, label] of [
    ["context-create-task", "message-circle-plus", "project.createTask"],
    ["context-files-0", "list-tree", "workspaceSidebar.showFileTree · /one"],
    ["context-files-1", "list-tree", "workspaceSidebar.showFileTree · /two"],
    ["edit", "pencil", "project.edit"],
    ["pin", pinned ? "pin-off" : "pin", pinned ? "project.unpin" : "project.pin"],
    ["delete", "trash-2", "project.delete"],
  ]) {
    const item = screen.getByTestId(`virtual-project-${id}`);
    const svg = item.querySelector(`svg.lucide-${icon}`);
    expect(svg, id).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(item.textContent).toBe(label);
  }
  fireEvent.click(screen.getByTestId("virtual-project-pin"));
  expect(props.onPin).toHaveBeenCalledOnce();
  expect(props.onExpandedChange).not.toHaveBeenCalled();
});
it("keeps a pinned project's pin in the leading slot and removes it when unpinned", () => {
  const props = fixture(["/one", "/two"]);
  props.project.pinned = true;
  const { rerender } = render(createElement(ProjectNode, props));
  const toggle = screen.getByTestId("virtual-project-toggle");
  const leading = toggle.firstElementChild!;
  expect(leading.querySelector(".lucide-folders-open")).not.toBeNull();
  expect(leading.querySelector(".lucide-pin")).not.toBeNull();
  expect(toggle.querySelectorAll(".lucide-pin")).toHaveLength(1);
  fireEvent.click(toggle);
  expect(props.onExpandedChange).toHaveBeenCalledWith(false);
  expect(props.onPin).not.toHaveBeenCalled();
  rerender(createElement(ProjectNode, { ...props, project: { ...props.project, pinned: false } }));
  expect(toggle.querySelector(".lucide-pin")).toBeNull();
  expect(toggle.querySelector(".lucide-folders-open")).not.toBeNull();
});
it("uses stacked closed/open folders for multiple roots and updates when roots change", () => {
  const props = fixture(["/one", "/two"]);
  const { rerender } = render(createElement(ProjectNode, props));
  const toggle = screen.getByTestId("virtual-project-toggle");
  expect(toggle.querySelector(".lucide-folders-open")).not.toBeNull();
  rerender(createElement(ProjectNode, { ...props, expanded: false }));
  expect(toggle.querySelector(".lucide-folders")).not.toBeNull();
  for (const roots of [["/one"], []]) {
    rerender(createElement(ProjectNode, fixture(roots)));
    expect(toggle.querySelector(".lucide-folder-open")).not.toBeNull();
    expect(toggle.querySelector(".lucide-folders, .lucide-folders-open")).toBeNull();
  }
});
it("keeps an empty project's file shortcut disabled without creating a root", () => {
  const props = fixture([]);
  render(createElement(ProjectNode, props));
  expect((screen.getByTestId("virtual-project-files") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTestId("virtual-project-files"));
  expect(props.onViewFiles).not.toHaveBeenCalled();
});

it("keeps content in the controlled collapsible lifecycle instead of removing it immediately", () => {
  const props = fixture();
  const { rerender } = render(createElement(ProjectNode, props));
  const content = screen.getByTestId("virtual-project-tasks");
  const toggle = screen.getByTestId("virtual-project-toggle");
  expect(toggle.getAttribute("aria-controls")).toBe(content.id);
  expect(content.getAttribute("data-state")).toBe("open");
  rerender(createElement(ProjectNode, { ...props, expanded: false }));
  expect(screen.getByTestId("virtual-project-tasks")).toBe(content);
  expect(content.getAttribute("data-state")).toBe("closed");
  rerender(createElement(ProjectNode, props));
  expect(content.getAttribute("data-state")).toBe("open");
  expect(props.onSelect).not.toHaveBeenCalled();
});

it("highlights the whole session target across nested rows and clears on leave, drop and cancel", () => {
  const props = fixture();
  const { container } = render(createElement(ProjectNode, props));
  const target = container.querySelector("section")!;
  const child = screen.getByTestId("virtual-project-toggle");
  const dataTransfer = {
    types: [WORKBENCH_SESSION_DRAG_MIME],
    getData: () =>
      serializeWorkbenchSessionDragPayload({
        kind: "zcode/session",
        workspacePath: "/repo",
        sessionId: "s",
      }),
  };
  const indicator = () => target.querySelector('[data-testid="project-session-drop-target"]');
  fireEvent.dragEnter(target, { dataTransfer });
  expect(indicator()).not.toBeNull();
  expect(target.classList.contains("bg-accent")).toBe(true);
  fireEvent.dragEnter(child, { dataTransfer });
  fireEvent.dragLeave(target, { dataTransfer });
  expect(indicator()).not.toBeNull();
  fireEvent.dragLeave(child, { dataTransfer });
  expect(indicator()).toBeNull();
  fireEvent.dragEnter(target, { dataTransfer });
  fireEvent.dragEnd(document);
  expect(indicator()).toBeNull();
  fireEvent.dragEnter(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
  expect(indicator()).toBeNull();
  expect(props.onMove).toHaveBeenCalledOnce();
});

it("does not highlight unrelated or read-only drops and clears when availability changes", () => {
  const props = fixture();
  const { container, rerender } = render(createElement(ProjectNode, props));
  const target = container.querySelector("section")!;
  const dataTransfer = {
    types: [WORKBENCH_SESSION_DRAG_MIME],
    getData: () =>
      serializeWorkbenchSessionDragPayload({
        kind: "zcode/session",
        workspacePath: "/repo",
        sessionId: "s",
      }),
  };
  fireEvent.dragEnter(target, { dataTransfer: { ...dataTransfer, types: ["Files"] } });
  expect(target.querySelector('[data-testid="project-session-drop-target"]')).toBeNull();
  fireEvent.dragEnter(target, { dataTransfer });
  rerender(createElement(ProjectNode, { ...props, availability: { online: false } }));
  expect(target.querySelector('[data-testid="project-session-drop-target"]')).toBeNull();
  fireEvent.dragEnter(target, { dataTransfer });
  expect(target.querySelector('[data-testid="project-session-drop-target"]')).toBeNull();
  rerender(
    createElement(ProjectNode, { ...props, project: { ...props.project, legacySingleRoot: true } }),
  );
  fireEvent.dragEnter(target, { dataTransfer });
  expect(target.querySelector('[data-testid="project-session-drop-target"]')).toBeNull();
});
it("offers remote device settings after extra actions and before edit when an opener is provided", () => {
  const props = fixture();
  const onOpenDeviceSettings = vi.fn();
  const sync = vi.fn();
  render(
    createElement(ProjectNode, {
      ...props,
      onOpenDeviceSettings,
      additionalActions: [{ id: "sync-skills-0", label: "remote.syncSkills", run: sync }],
    }),
  );
  fireEvent.contextMenu(screen.getByTestId("virtual-project-toggle"));
  const item = screen.getByTestId("virtual-project-device-settings");
  expect(item.textContent).toBe("project.deviceSettings");
  expect(item.querySelector("svg.lucide-settings")).not.toBeNull();
  const ids = Array.from(document.querySelectorAll("[data-testid^='virtual-project-']"))
    .map((node) => node.getAttribute("data-testid"))
    .filter((id) =>
      ["sync-skills-0", "device-settings", "edit"].some((key) => id === `virtual-project-${key}`),
    );
  expect(ids).toEqual([
    "virtual-project-sync-skills-0",
    "virtual-project-device-settings",
    "virtual-project-edit",
  ]);
  fireEvent.click(item);
  expect(onOpenDeviceSettings).toHaveBeenCalledOnce();
  expect(sync).not.toHaveBeenCalled();
});
it("omits remote device settings without an opener", () => {
  render(createElement(ProjectNode, fixture()));
  fireEvent.contextMenu(screen.getByTestId("virtual-project-toggle"));
  expect(screen.getByTestId("virtual-project-edit")).toBeDefined();
  expect(screen.queryByTestId("virtual-project-device-settings")).toBeNull();
});
