import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SIDEBAR_RESIZE_END_EVENT,
  WORKSPACE_SIDEBAR_RESIZING_ATTR,
  isWorkspaceSidebarResizeActiveForElement,
  setWorkspaceSidebarResizeActive,
} from "../src/lib/workspaceSidebarResizeState.js";

class FakeResizeElement {
  readonly dispatchedEventTypes: string[] = [];
  private readonly attributes = new Map<string, string>();

  constructor(private readonly shellElement: FakeResizeElement | null = null) {}

  closest(selector: string) {
    return selector === "[data-workspace-shell]" ? this.shellElement : null;
  }

  dispatchEvent(event: Event) {
    this.dispatchedEventTypes.push(event.type);
    return true;
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}

describe("workspace sidebar resize state", () => {
  it("stores active sidebar resize state on shell and panel DOM attributes", () => {
    const shellElement = new FakeResizeElement();
    const panelElement = new FakeResizeElement(shellElement);
    const scrollElement = new FakeResizeElement(shellElement);

    setWorkspaceSidebarResizeActive({
      active: true,
      panelElement: panelElement as unknown as HTMLElement,
      shellElement: shellElement as unknown as HTMLElement,
    });

    expect(shellElement.getAttribute(WORKSPACE_SIDEBAR_RESIZING_ATTR)).toBe("true");
    expect(panelElement.getAttribute(WORKSPACE_SIDEBAR_RESIZING_ATTR)).toBe("true");
    expect(isWorkspaceSidebarResizeActiveForElement(scrollElement as unknown as HTMLElement)).toBe(
      true,
    );

    setWorkspaceSidebarResizeActive({
      active: false,
      panelElement: panelElement as unknown as HTMLElement,
      shellElement: shellElement as unknown as HTMLElement,
    });

    expect(shellElement.getAttribute(WORKSPACE_SIDEBAR_RESIZING_ATTR)).toBeNull();
    expect(panelElement.getAttribute(WORKSPACE_SIDEBAR_RESIZING_ATTR)).toBeNull();
    expect(shellElement.dispatchedEventTypes).toEqual([WORKSPACE_SIDEBAR_RESIZE_END_EVENT]);
    expect(isWorkspaceSidebarResizeActiveForElement(scrollElement as unknown as HTMLElement)).toBe(
      false,
    );
  });
});
