// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_REMOTE_ASSET_INSTALL_MODE } from "@zcode/shared";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";

const listSSHConfigAliases = vi.fn(async () => []);

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    isLocalDevelopmentRuntime: false,
    listSSHConfigAliases,
  }),
}));

beforeEach(() => {
  listSSHConfigAliases.mockClear();
});

describe("remote connection asset install mode default", () => {
  it("starts every newly opened connection form from the shared local-upload default", () => {
    const { result, rerender } = renderHook(
      ({ open }) =>
        useRemoteConnectionForm({
          open,
          isWindowsDesktop: false,
        }),
      { initialProps: { open: true } },
    );

    expect(result.current.assetInstallMode).toBe(DEFAULT_REMOTE_ASSET_INSTALL_MODE);
    act(() => result.current.setAssetInstallMode("remote-download"));
    expect(result.current.assetInstallMode).toBe("remote-download");

    rerender({ open: false });
    rerender({ open: true });
    expect(result.current.assetInstallMode).toBe(DEFAULT_REMOTE_ASSET_INSTALL_MODE);
  });
});
