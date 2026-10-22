// @vitest-environment jsdom
import { createContext, createElement, useContext, type ReactElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import { projectKey } from "@/project-sidebar/view.js";

const spies = vi.hoisted(() => ({ tooltip: vi.fn(), tasks: vi.fn() }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactElement }) => {
    spies.tooltip();
    return children;
  },
}));
vi.mock("@/project-sidebar/ProjectTaskRows.js", () => ({
  ProjectTaskRows: () => {
    spies.tasks();
    return null;
  },
}));
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: ({ id }: { id: string }) => {
    const drag = useContext(DragState);
    const index = keys.indexOf(id);
    const isDragging = index === drag.active;
    return {
      setNodeRef: nodeRef,
      setActivatorNodeRef: nodeRef,
      listeners,
      attributes: isDragging ? pressedAttributes : idleAttributes,
      transform: drag.active < 0 ? null : { x: 0, y: drag.y, scaleX: 1, scaleY: 1 },
      transition: undefined,
      active: drag.active < 0 ? null : { id: keys[drag.active], data: { current: data } },
      activeIndex: drag.active,
      index,
      isDragging,
      isOver: index === drag.over,
    };
  },
}));

const DragState = createContext({ active: -1, over: -1, y: 0 });
const nodeRef = () => {};
const listeners = {};
const idleAttributes = { role: "button", tabIndex: 0 };
const pressedAttributes = { ...idleAttributes, "aria-pressed": true };
const data = { hostId: "local", pinned: false };
const projects = Array.from({ length: 41 }, (_, index) => ({
  id: `p${index}`,
  hostId: "local",
  name: `Project ${index}`,
  roots: [],
  deleted: false,
  pinned: false,
  nameOverridden: false,
  position: index,
  createdAt: 1,
  updatedAt: 1,
}));
const keys = projects.map(projectKey);
afterEach(cleanup);

it("41 个项目的拖拽激活/移动/取消只刷新活动项内容，业务变化仍更新", () => {
  const props = projects.map((project) => ({
    project,
    expanded: true,
    tasks: [],
    onExpandedChange: vi.fn(),
    onCreate: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onPin: vi.fn(),
    onMove: vi.fn(),
    onSelect: vi.fn(),
    refresh: vi.fn(async () => {}),
  }));
  const nodes = props.map((p) => createElement(ProjectNode, { ...p, key: p.project.id }));
  const tree = (active: number, over: number, y: number, children = nodes) =>
    createElement(DragState.Provider, { value: { active, over, y } }, children);
  const { container, rerender } = render(tree(-1, -1, 0));
  spies.tooltip.mockClear();
  spies.tasks.mockClear();
  rerender(tree(0, 1, 32));
  const toggle = container.querySelector('[data-project-id="p0"] button')!;
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(
    container.querySelector('[data-project-id="p1"] [data-drop-position="after"]'),
  ).not.toBeNull();
  expect(spies.tooltip.mock.calls.length).toBeLessThanOrEqual(4);
  expect(spies.tasks.mock.calls.length).toBeLessThanOrEqual(1);

  spies.tooltip.mockClear();
  spies.tasks.mockClear();
  for (const [over, y] of [
    [1, 40],
    [2, 64],
    [3, 96],
  ])
    rerender(tree(0, over!, y!));
  expect(spies.tooltip).not.toHaveBeenCalled();
  expect(spies.tasks).not.toHaveBeenCalled();
  expect(container.querySelectorAll('[data-testid="project-drop-indicator"]')).toHaveLength(1);
  expect(
    container.querySelector('[data-project-id="p3"] [data-drop-position="after"]'),
  ).not.toBeNull();
  rerender(tree(-1, -1, 0));
  expect(toggle.hasAttribute("aria-pressed")).toBe(false);
  expect(container.querySelector('[data-testid="project-drop-indicator"]')).toBeNull();
  expect(spies.tooltip.mock.calls.length).toBeLessThanOrEqual(4);
  expect(spies.tasks.mock.calls.length).toBeLessThanOrEqual(1);

  const onCreate = vi.fn();
  const changed = [...nodes];
  changed[1] = createElement(ProjectNode, {
    ...props[1]!,
    key: "p1",
    project: { ...projects[1]!, name: "Renamed" },
    onCreate,
  });
  rerender(tree(-1, -1, 0, changed));
  expect(container.querySelector('[data-project-id="p1"]')!.textContent).toContain("Renamed");
  fireEvent.click(
    container.querySelector('[data-project-id="p1"] [data-testid="virtual-project-create-task"]')!,
  );
  expect(onCreate).toHaveBeenCalledOnce();
  expect(props[1]!.onCreate).not.toHaveBeenCalled();
});
