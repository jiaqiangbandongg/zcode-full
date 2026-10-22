// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useProjectSidebarPreferences } from "@/project-sidebar/useProjectSidebarPreferences.js";
import type { VirtualProject } from "@/project-sidebar/contract.js";
const projects = [
  { id: "same", hostId: "local", roots: [], pinned: true },
  { id: "same", hostId: "remote:server:one", roots: [] },
] as VirtualProject[];
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("bulk expansion shares the per-project preference, preserves other hosts and survives remount", () => {
  const first = renderHook(() => useProjectSidebarPreferences(projects, false));
  act(() => first.result.current.setAllExpanded(projects, false));
  expect(projects.map(first.result.current.isExpanded)).toEqual([false, false]);
  act(() => first.result.current.setAllExpanded([projects[0]!], true));
  expect(projects.map(first.result.current.isExpanded)).toEqual([true, false]);
  first.unmount();
  const restored = renderHook(() => useProjectSidebarPreferences(projects, false));
  expect(projects.map(restored.result.current.isExpanded)).toEqual([true, false]);
  act(() => restored.result.current.setAllExpanded(projects, true));
  expect(projects.map(restored.result.current.isExpanded)).toEqual([true, true]);
});
