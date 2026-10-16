import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button.js", () => ({
  Button: ({
    children,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => createElement("button", props, children),
}));

vi.mock("@/components/ui/input.js", () => ({
  Input: (props: Record<string, unknown>) => createElement("input", props),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    error: vi.fn(),
  },
}));

async function importDirectoryBrowserModule() {
  return (await import("../src/DirectoryBrowser.js")) as unknown as {
    DirectoryBrowser: typeof import("../src/DirectoryBrowser.js").DirectoryBrowser;
    createDirectoryBrowserReadParams: (
      path: string,
      showHiddenDirectories: boolean,
    ) => { path: string; includeHidden?: boolean };
    createDirectoryBrowserRequestGuard: () => {
      begin: () => number;
      isCurrent: (requestId: number) => boolean;
    };
    getDirectoryBrowserEntryIconKind: (
      entry: { type: "directory" | "file"; isSymbolicLink?: boolean },
    ) => "folder" | "folder-symlink";
    filterDirectoryBrowserEntries: (
      entries: Array<{
        name: string;
        path: string;
        type: "directory" | "file";
        isSymbolicLink?: boolean;
      }>,
    ) => Array<{
      name: string;
      path: string;
      type: "directory" | "file";
      isSymbolicLink?: boolean;
    }>;
  };
}

async function renderDirectoryBrowser(embedded = false) {
  const { DirectoryBrowser } = await importDirectoryBrowserModule();

  return renderToStaticMarkup(
    createElement(DirectoryBrowser, {
      services: {
        fileService: {
          readdir: vi.fn(async () => []),
        },
        systemService: {
          info: vi.fn(async () => ({ homedir: "/Users/tester" })),
        },
      } as never,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
      embedded,
    }),
  );
}

describe("DirectoryBrowser", () => {
  it("renders the hidden directory toggle", async () => {
    const html = await renderDirectoryBrowser(true);

    expect(html).toContain("directoryBrowser.showHidden");
  });

  it("renders a select action in non-embedded mode", async () => {
    const html = await renderDirectoryBrowser();

    expect(html).toContain("directoryBrowser.selectDir");
  });

  it("leaves the select action to the parent in embedded mode", async () => {
    const html = await renderDirectoryBrowser(true);

    expect(html).not.toContain("directoryBrowser.selectDir");
  });

  it("does not request hidden entries by default", async () => {
    const { createDirectoryBrowserReadParams } = await importDirectoryBrowserModule();

    expect(createDirectoryBrowserReadParams("/root", false)).toEqual({
      path: "/root",
    });
  });

  it("requests hidden entries when the toggle is enabled", async () => {
    const { createDirectoryBrowserReadParams } = await importDirectoryBrowserModule();

    expect(createDirectoryBrowserReadParams("/root", true)).toEqual({
      path: "/root",
      includeHidden: true,
    });
  });

  it("marks older directory reads as stale after a newer navigation starts", async () => {
    const { createDirectoryBrowserRequestGuard } = await importDirectoryBrowserModule();
    const guard = createDirectoryBrowserRequestGuard();

    const firstRequestId = guard.begin();
    const secondRequestId = guard.begin();

    expect(guard.isCurrent(firstRequestId)).toBe(false);
    expect(guard.isCurrent(secondRequestId)).toBe(true);
  });

  it("keeps hidden directories returned by the service but still filters files", async () => {
    const { filterDirectoryBrowserEntries } = await importDirectoryBrowserModule();

    expect(
      filterDirectoryBrowserEntries([
        { name: ".ssh", path: "/root/.ssh", type: "directory" },
        { name: ".bashrc", path: "/root/.bashrc", type: "file" },
        { name: "project", path: "/root/project", type: "directory" },
      ]),
    ).toEqual([
      { name: ".ssh", path: "/root/.ssh", type: "directory" },
      { name: "project", path: "/root/project", type: "directory" },
    ]);
  });

  it("uses a symlink folder icon kind for directory symlinks", async () => {
    const { getDirectoryBrowserEntryIconKind } = await importDirectoryBrowserModule();

    expect(
      getDirectoryBrowserEntryIconKind({
        type: "directory",
        isSymbolicLink: true,
      }),
    ).toBe("folder-symlink");
    expect(
      getDirectoryBrowserEntryIconKind({
        type: "directory",
      }),
    ).toBe("folder");
  });
});
