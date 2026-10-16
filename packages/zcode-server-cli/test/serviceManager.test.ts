import { describe, expect, it } from "vitest";
import { createServiceDescriptor, registerService, unregisterService } from "../src/platform/serviceManager.js";

describe("service manager adapters", () => {
  it("maps all supported platforms to their native registration commands", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const executor = { run: async (command: string, args: readonly string[]) => { calls.push({ command, args }); } };
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const descriptor = createServiceDescriptor({ platform, command: "/opt/zcode/bin/zcode", args: ["serve", "--daemon"] });
      await registerService(descriptor, `/tmp/${descriptor.kind}.service`, executor);
      await unregisterService(descriptor, `/tmp/${descriptor.kind}.service`, executor);
    }
    expect(calls.map((call) => call.command)).toEqual([
      "launchctl", "launchctl", "launchctl", "launchctl",
      "systemctl", "systemctl", "systemctl",
      "schtasks", "schtasks", "schtasks",
    ]);
    expect(calls.at(-2)?.args).toContain("/Run");
  });

  it("does not restart a launchd service after a normal stop", () => {
    const descriptor = createServiceDescriptor({ platform: "darwin", command: "/opt/zcode/bin/zcode" });
    expect(descriptor.content).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  });

  it("tolerates launchd unregister when a deferred registration was never loaded", async () => {
    const descriptor = createServiceDescriptor({ platform: "darwin", command: "/opt/zcode/bin/zcode" });
    await expect(unregisterService(descriptor, "/tmp/zcode.plist", {
      run: async () => {
        throw new Error("launchctl unload failed (3): Could not find specified service");
      },
    })).resolves.toBeUndefined();
  });

  it("tolerates a missing Windows task when schtasks reports a missing file", async () => {
    const descriptor = createServiceDescriptor({ platform: "win32", command: "C:/zcode/bin/zcode.cmd" });
    await expect(unregisterService(descriptor, "C:/zcode/service/task.json", {
      run: async () => {
        throw new Error("schtasks /Delete failed (1): ERROR: The system cannot find the file specified.");
      },
    })).resolves.toBeUndefined();
  });

  it("does not swallow Windows task permission failures", async () => {
    const descriptor = createServiceDescriptor({ platform: "win32", command: "C:/zcode/bin/zcode.cmd" });
    await expect(unregisterService(descriptor, "C:/zcode/service/task.json", {
      run: async () => {
        throw new Error("schtasks /Delete failed (5): Access is denied.");
      },
    })).rejects.toThrow(/Access is denied/);
  });

  it("uses the structured schtasks HRESULT probe before deleting a Windows task", async () => {
    const descriptor = createServiceDescriptor({ platform: "win32", command: "C:/zcode/bin/zcode.cmd" });
    const calls: string[][] = [];
    await expect(unregisterService(descriptor, "C:/zcode/service/task.json", {
      run: async (_command, args) => { calls.push([...args]); },
      runResult: async (_command, args) => {
        calls.push([...args]);
        return { exitCode: 0x80070002, stderr: "" };
      },
    })).resolves.toBeUndefined();
    expect(calls).toEqual([["/Query", "/TN", descriptor.name, "/HResult"]]);
  });

  it("does not treat a structured Windows task query permission error as absence", async () => {
    const descriptor = createServiceDescriptor({ platform: "win32", command: "C:/zcode/bin/zcode.cmd" });
    await expect(unregisterService(descriptor, "C:/zcode/service/task.json", {
      run: async () => undefined,
      runResult: async () => ({ exitCode: 0x80070005, stderr: "Access is denied." }),
    })).rejects.toThrow(/failed \(2147942405\)/);
  });

  it("reloads an existing launchd label before starting the new descriptor", async () => {
    const descriptor = createServiceDescriptor({ platform: "darwin", command: "/opt/zcode/bin/zcode", args: ["serve", "--new"] });
    const calls: string[][] = [];
    await registerService(descriptor, "/tmp/new.plist", {
      run: async (_command, args) => {
        calls.push([...args]);
        if (args[0] === "unload") throw new Error("Could not find specified service");
      },
    });
    expect(calls).toEqual([
      ["unload", "-w", "/tmp/new.plist"],
      ["load", "-w", "/tmp/new.plist"],
      ["start", descriptor.name],
    ]);
  });

  it("propagates launchd load failures with the descriptor path", async () => {
    const descriptor = createServiceDescriptor({ platform: "darwin", command: "/opt/zcode/bin/zcode" });
    await expect(registerService(descriptor, "/tmp/broken.plist", {
      run: async (_command, args) => {
        if (args[0] === "load") throw new Error("permission denied");
      },
    })).rejects.toThrow(/broken\.plist/);
  });
});
