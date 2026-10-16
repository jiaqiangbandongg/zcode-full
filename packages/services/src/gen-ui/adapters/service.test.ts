import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createGenUiService } from "./service.js";
import type { PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
it("registers restricted Gen UI provenance with synchronous, escaped initial state", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "gen-ui-service-"));
  let input: PluginSandboxRegisterInput | undefined;
  const service = createGenUiService({
    stateRoot,
    registerSandbox: async (value) => {
      input = value;
      return {
        instance: value.instance,
        sandboxId: "sandbox",
        initId: 1,
        partition: "gen-ui",
        shellUrl: "zcode-sandbox://fixture",
      };
    },
  });
  const target = {
    workspacePath: "/work",
    workspaceIdentity: "remote:fixture",
    sessionId: "s",
    path: "/work/demo.html",
  };
  try {
    await service.setState({
      target,
      state: { modelContent: null, privateContent: "</script><script>evil()</script>" },
    });
    await service.prepareSandbox({
      ...target,
      html: '<p id="content">Hello</p>',
      ownerWebContentsId: 1,
      instanceKey: "row:0",
    });
    expect(input?.contentKind).toBe("gen-ui");
    expect(input?.pluginId).toBeUndefined();
    expect(input?.serverName).toBeUndefined();
    expect(input?.csp?.connectDomains).toEqual([]);
    expect(input?.csp?.frameDomains).toEqual([]);
    expect(input?.html).not.toContain("<script>evil()");
    expect(input!.html.indexOf("zcode-gen-ui-initial-state")).toBeLessThan(
      input!.html.indexOf("__ZCODE_GEN_UI_RUNTIME__"),
    );
    await expect(
      service.prepareSandbox({
        ...target,
        html: "<html></html>",
        ownerWebContentsId: 1,
        instanceKey: "row:0",
      }),
    ).rejects.toThrow("fragment");
  } finally {
    service.dispose();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
