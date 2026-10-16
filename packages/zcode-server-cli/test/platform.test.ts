import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createDaemonServiceDescriptor, createServiceDescriptor, serviceDescriptorPath } from "../src/platform/serviceManager.js";
import { resolveServerLayout, stablePathId } from "../src/runtime/paths.js";

describe("user service descriptors", () => {
  it.each([
    ["darwin", "launchd"],
    ["linux", "systemd"],
    ["win32", "task-scheduler"],
  ] as const)("creates a stable %s descriptor", (platform, kind) => {
    const descriptor = createServiceDescriptor({ platform, command: "/opt/zcode/bin/zcode" });
    expect(descriptor.kind).toBe(kind);
    expect(descriptor.content).toContain("zcode");
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "pins the %s daemon descriptor to the data-root stable launcher and explicit server root",
    (platform) => {
      const layout = resolveServerLayout("/var/lib/zcode-custom/.zcode/server");
      const descriptor = createDaemonServiceDescriptor({ platform, layout });
      const launcher = join(layout.stableBinDir, platform === "win32" ? "zcode.cmd" : "zcode");
      if (platform === "win32") {
        const task = JSON.parse(descriptor.content) as { command: string; args: string[] };
        expect(task.command).toBe(launcher);
        expect(task.args).toContain(layout.serverRoot);
      } else {
        expect(descriptor.content).toContain(launcher);
      }
      expect(descriptor.content).toContain("--server-root");
      expect(descriptor.content).toContain("--service-entry");
      if (platform !== "win32") {
        expect(descriptor.content).toContain(layout.serverRoot);
      }
      expect(descriptor.content).not.toContain("server-cli.js");
      expect(descriptor.name).toBe(`com.zhipu.zcode.server.${stablePathId(layout.serverRoot)}`);
    },
  );

  it("isolates service identity and descriptor filenames by server root", () => {
    const firstLayout = resolveServerLayout("/var/lib/zcode-first/.zcode/server");
    const secondLayout = resolveServerLayout("/var/lib/zcode-second/.zcode/server");
    const first = createDaemonServiceDescriptor({ platform: "linux", layout: firstLayout });
    const second = createDaemonServiceDescriptor({ platform: "linux", layout: secondLayout });

    expect(first.name).not.toBe(second.name);
    expect(serviceDescriptorPath(firstLayout, first)).toBe(join(firstLayout.serviceDir, `${first.name}.service`));
    expect(serviceDescriptorPath(secondLayout, second)).toBe(join(secondLayout.serviceDir, `${second.name}.service`));
  });
});
