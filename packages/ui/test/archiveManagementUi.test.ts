// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArchiveGroupCard } from "@/project-sidebar/ArchiveGroupCard.js";
import { buildArchiveGroups, buildArchiveProjectOptions } from "@/project-sidebar/archive-view.js";
import type { ProjectTree } from "@/project-sidebar/contract.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
const mock = vi.hoisted(() => ({ locale: "zh-CN" }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: mock.locale,
    intl: {
      formatMessage: ({ id }: { id: string }, values: Record<string, number | string> = {}) =>
        Object.entries(values).reduce(
          (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
          (mock.locale === "zh-CN" ? zhCN : enUS)[id] ?? id,
        ),
    },
  }),
}));
afterEach(cleanup);
it.each(["zh-CN", "en-US"])(
  "mounts archived rows only while expanded and preserves pagination: %s",
  (locale) => {
    mock.locale = locale;
    const tree: ProjectTree = {
      projects: [],
      tasks: Array.from({ length: 51 }, (_, i) => ({
        taskId: `t${i}`,
        title: `Long title ${i} ` + "x".repeat(100),
        traceId: `t${i}`,
        workspacePath: "/root",
        projectId: null,
        hostId: "local",
        archived: true,
        pinned: false,
        mode: "default",
        createdAt: 1,
        updatedAt: 2,
      })),
    };
    const onAction = vi.fn(async () => {});
    const group = buildArchiveGroups(tree)[0]!;
    render(
      createElement(ArchiveGroupCard, {
        group,
        name: "Virtual title",
        sort: "updated",
        disabled: false,
        onAction,
      }),
    );
    expect(screen.queryAllByTestId("archive-task")).toHaveLength(0);
    expect(screen.queryByTestId("archive-show-more")).toBeNull();
    const toggle = screen.getByTestId("archive-group-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("archive-group-menu")).toBeTruthy();
    expect(screen.getByTestId("archive-group").textContent).toContain("51");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("archive-task")).toHaveLength(50);
    expect(screen.getAllByTestId("archive-unarchive")).toHaveLength(50);
    fireEvent.click(screen.getByTestId("archive-show-more"));
    expect(screen.getAllByTestId("archive-task")).toHaveLength(51);
    fireEvent.click(screen.getAllByTestId("archive-unarchive")[0]!);
    expect(onAction).toHaveBeenCalledWith([group.tasks[0]], "unarchive");
    expect(screen.getAllByTitle(/^Long title/)[0]!.textContent).toBe(group.tasks[0]!.title);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByTestId("archive-task")).toHaveLength(0);
    expect(screen.queryAllByTestId("archive-unarchive")).toHaveLength(0);
    expect(screen.queryByTestId("archive-show-more")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getAllByTestId("archive-task")).toHaveLength(51);
  },
);
it("keeps project options with zero archived rows, including same roots under different IDs", () => {
  const project = {
    hostId: "local",
    name: "virtual",
    roots: [{ rootPath: "/shared", isPrimary: true, position: 0 }],
    deleted: false,
    pinned: false,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    nameOverridden: true,
  };
  const options = buildArchiveProjectOptions({
    projects: [
      { ...project, id: "p1" },
      { ...project, id: "p2" },
    ],
    tasks: [],
  });
  expect(options.map((p) => p.project?.id)).toEqual(["p1", "p2"]);
});
