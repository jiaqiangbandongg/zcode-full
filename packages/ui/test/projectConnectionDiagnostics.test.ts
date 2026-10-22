// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useProjectConnectionDiagnostics } from "@/project-sidebar/useProjectConnectionDiagnostics.js";
import type { ProjectSidebarProps, RemoteProjectDirectory } from "@/project-sidebar/contract.js";

it("keeps live errors scoped to the current Host", () => {
  const host = {
    id: "remote:server:one",
    membershipId: "first",
    connectionStatus: "offline",
    lastConnectionError: "SSH refused",
  } as RemoteProjectDirectory["hosts"][number];
  const props = {
    remoteWorkspaceErrorByWorkspaceKey: { "remote:server:two:/repo": "other host" },
  } as unknown as ProjectSidebarProps;
  const { result, rerender } = renderHook(
    (directory) => useProjectConnectionDiagnostics(directory, props),
    { initialProps: { hosts: [host], entries: [] } as RemoteProjectDirectory },
  );
  expect(result.current.get(host.id)?.error).toBe("SSH refused");
  rerender({ hosts: [{ ...host, connectionStatus: "online" }], entries: [] });
  expect(result.current.get(host.id)?.error).toBeUndefined();
  rerender({ hosts: [{ ...host, lastConnectionError: undefined }], entries: [] });
  expect(result.current.get(host.id)?.error).toBeUndefined();
});
