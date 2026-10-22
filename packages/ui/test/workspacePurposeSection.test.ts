import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePurposeSection } from "@/WorkspaceSidebar/WorkspacePurposeSection.js";

const sortable = vi.hoisted(() => ({
  active: null as { id: string } | null,
  activeIndex: -1,
  index: 0,
  isOver: false,
  isDragging: false,
}));
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "button", tabIndex: 0 },
    listeners: {},
    setActivatorNodeRef: vi.fn(),
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    ...sortable,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: vi.fn() } },
}));

function renderSection(open: boolean, inset = false) {
  return renderToStaticMarkup(
    createElement(
      WorkspacePurposeSection,
      {
        title: "Projects",
        open,
        onOpenChange: vi.fn(),
        action: createElement("button", { "data-testid": "section-action" }, "Add"),
        testId: "purpose-section",
        sortableId: "projects",
        dragHandleLabel: "Move Projects section",
        inset,
      },
      createElement("div", { "data-testid": "section-content" }, "Details"),
    ),
  );
}

describe("WorkspacePurposeSection", () => {
  beforeEach(() => {
    Object.assign(sortable, {
      active: null,
      activeIndex: -1,
      index: 0,
      isOver: false,
      isDragging: false,
    });
  });
  it("renders the expanded state with content and a down chevron", () => {
    const html = renderSection(true);

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-purpose-section-chevron="expanded"');
    expect(html).toContain('data-testid="section-content"');
  });

  it("renders the collapsed state with a right chevron and hidden content", () => {
    const html = renderSection(false);

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-purpose-section-chevron="collapsed"');
    expect(html).not.toContain('data-testid="section-content"');
  });

  it("keeps the action outside the collapse trigger and exposes accessible visibility fallbacks", () => {
    const html = renderSection(true);
    const triggerEndIndex = html.indexOf("</button>");
    const dragTriggerIndex = html.indexOf('data-purpose-section-drag-trigger="projects"');
    const actionIndex = html.indexOf('data-testid="section-action"');

    expect(triggerEndIndex).toBeGreaterThan(-1);
    expect(dragTriggerIndex).toBeGreaterThan(-1);
    expect(dragTriggerIndex).toBeLessThan(triggerEndIndex);
    expect(actionIndex).toBeGreaterThan(triggerEndIndex);
    expect(html).not.toContain("data-purpose-section-drag-handle");
    expect(html).not.toContain("lucide-grip-vertical");
    expect(html).toContain('aria-description="Move Projects section"');
    expect(html).toContain("touch-none");
    expect(html).toContain("group-hover/purpose-section:opacity-100");
    expect(html).toContain("group-focus-within/purpose-section:opacity-100");
    expect(html).toContain("has-[[data-state=open]]:opacity-100");
    expect(html).toContain("[@media(hover:none)]:opacity-100");
  });

  it.each([
    [1, 0, "before"],
    [0, 1, "after"],
  ] as const)(
    "shows the target edge for source %s and target %s",
    (activeIndex, index, position) => {
      Object.assign(sortable, {
        active: { id: "conversations" },
        activeIndex,
        index,
        isOver: true,
      });
      const html = renderSection(true);
      expect(html).toContain('data-testid="purpose-section-drop-indicator"');
      expect(html).toContain(`data-drop-position="${position}"`);
      expect(html).toContain("bg-icon-blue");
      expect(html).toContain("pointer-events-none");
      expect(html).toContain("border-icon-blue");
    },
  );

  it("does not mark the dragged section, unrelated targets, or cancelled drags", () => {
    Object.assign(sortable, {
      active: { id: "projects" },
      activeIndex: 0,
      isOver: true,
      isDragging: true,
    });
    expect(renderSection(true)).not.toContain("purpose-section-drop-indicator");
    Object.assign(sortable, { isDragging: false, isOver: false });
    expect(renderSection(true)).not.toContain("purpose-section-drop-indicator");
    Object.assign(sortable, { active: null, isOver: true });
    expect(renderSection(true)).not.toContain("purpose-section-drop-indicator");
  });

  it("uses one shared child inset when rendered below a Source band", () => {
    const html = renderSection(true, true);

    expect(html).toContain('data-source-hierarchy-children="true"');
    expect(html).toContain("ml-6");
    expect(html).toContain("mr-1");
  });
});
