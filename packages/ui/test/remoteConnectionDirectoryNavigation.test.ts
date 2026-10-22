// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  version: 1,
  update: vi.fn(),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => {
  const settingService = {
    get: async () => ({ remoteBoundaryIntroAcknowledgedVersion: boundary.version }),
    update: async (patch: { remoteBoundaryIntroAcknowledgedVersion: number }) => {
      boundary.update(patch);
      boundary.version = patch.remoteBoundaryIntroAcknowledgedVersion;
    },
  };
  return { useOptionalBaseWorkspaceServices: () => ({ settingService }) };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/settings/RemoteSyncActions.js", () => ({
  RemoteSyncDialogs: () => null,
  RemoteSyncDropdownButton: () => null,
  shouldShowRemoteSyncActions: () => false,
}));

import { RemoteConnectionDirectoryStep } from "@/RemoteConnectionDialogContent.js";

beforeEach(() => {
  boundary.version = 1;
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RemoteConnectionDirectoryStep directory navigation", () => {
  it("enters a listed directory before the user confirms the workspace path", async () => {
    const onSelect = vi.fn();
    const readdir = vi.fn(async ({ path }: { path: string }) => {
      if (path === "/") {
        return [{ name: "home", path: "/home", type: "directory" as const }];
      }
      if (path === "/home") {
        return [{ name: "dev", path: "/home/dev", type: "directory" as const }];
      }
      return [];
    });

    render(
      createElement(RemoteConnectionDirectoryStep, {
        services: {
          fileService: { readdir },
          systemService: {
            info: vi.fn(async () => ({ homedir: "/", platform: "linux" })),
          },
        } as never,
        onSelect,
        onBack: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    const pathInput = await screen.findByPlaceholderText("directoryBrowser.pathPlaceholder");
    await waitFor(() => expect((pathInput as HTMLInputElement).value).toBe("/"));

    fireEvent.click(screen.getByRole("button", { name: "home" }));

    await waitFor(() => expect((pathInput as HTMLInputElement).value).toBe("/home"));
    expect(readdir).toHaveBeenCalledWith({ path: "/home" });
    expect(screen.getByRole("button", { name: "dev" })).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "remote.openWorkspaceHere" }));
    expect(onSelect).toHaveBeenCalledWith("/home");
  });
});

it("navigates recent and remote chips, blocks opening while loading or failed, and shows the full path", async () => {
  let finish!: () => void;
  const onSelect = vi.fn();
  const readdir = vi.fn(async ({ path }: { path: string }) => {
    if (path === "/srv/recent")
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    if (path === "/srv/missing") throw new Error("ENOENT: raw backend details");
    return [
      {
        name: path === "/srv/recent" ? "recent-child" : "home-child",
        path: `${path}/child`,
        type: "directory",
      },
    ];
  });
  render(
    createElement(RemoteConnectionDirectoryStep, {
      services: {
        fileService: { readdir },
        systemService: { info: async () => ({ homedir: "/home/dev" }) },
      } as never,
      quickOpenPaths: ["/srv/recent"],
      quickOpenEntries: [{ path: "/srv/missing" }],
      onSelect,
      onBack: vi.fn(),
      onCancel: vi.fn(),
      onChooseLater: vi.fn(),
    }),
  );
  await screen.findByRole("button", { name: "home-child" });
  fireEvent.click(screen.getByRole("button", { name: "/srv/recent" }));
  await waitFor(() => expect(readdir).toHaveBeenCalledWith({ path: "/srv/recent" }));
  expect(
    screen.getByRole("button", { name: "remote.openWorkspaceHere" }).hasAttribute("disabled"),
  ).toBe(true);
  finish();
  await screen.findByRole("button", { name: "recent-child" });
  expect(
    (screen.getByPlaceholderText("directoryBrowser.pathPlaceholder") as HTMLInputElement).value,
  ).toBe("/srv/recent");
  fireEvent.click(screen.getByRole("button", { name: "remote.openWorkspaceHere" }));
  expect(onSelect).toHaveBeenLastCalledWith("/srv/recent");
  fireEvent.click(screen.getByRole("button", { name: "/srv/recent" }));
  await waitFor(() =>
    expect(readdir.mock.calls.filter(([request]) => request.path === "/srv/recent")).toHaveLength(
      2,
    ),
  );
  finish();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "remote.openWorkspaceHere" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "/srv/missing" }));
  await screen.findByText("directoryBrowser.errorUnavailable");
  expect(screen.queryByText(/ENOENT/)).toBeNull();
  expect(
    screen.getByRole("button", { name: "remote.openWorkspaceHere" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByRole("button", { name: "remote.chooseLater" }).hasAttribute("disabled")).toBe(
    false,
  );
});

it("saves a renamed device without marking the introduction read", async () => {
  const onRenameDevice = vi.fn(async () => undefined);
  boundary.version = 0;
  render(
    createElement(RemoteConnectionDirectoryStep, {
      services: {
        fileService: { readdir: async () => [] },
        systemService: { info: async () => ({ homedir: "/home" }) },
      } as never,
      deviceName: "old-name",
      onRenameDevice,
      onSelect: vi.fn(),
      onBack: vi.fn(),
      onCancel: vi.fn(),
    }),
  );
  const field = screen.getByLabelText("remote.renameDevice");
  fireEvent.change(field, { target: { value: "new-name" } });
  fireEvent.blur(field);
  await screen.findByText("remote.renameSaved");
  expect(onRenameDevice).toHaveBeenCalledWith("new-name");
  expect(screen.queryByTestId("remote-boundary-hint")).toBeNull();
  expect(boundary.update).not.toHaveBeenCalled();
});
