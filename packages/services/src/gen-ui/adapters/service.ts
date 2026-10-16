import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { GEN_UI_OUTPUT_DIRECTORY } from "@zcode/shared/node";
import {
  GEN_UI_STATIC_DOMAINS,
  buildGenUiScopeKey,
  genUiStateTargetSchema,
} from "@zcode/shared/gen-ui";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import type { IGenUiService } from "../contract.js";
import { getAppConfigDir } from "../../paths.js";
import { assertGenUiFragment, readGenUiDocument } from "./files.js";
import { createGenUiStateStorage } from "./stateStorage.js";

const prepareSchema = genUiStateTargetSchema.extend({
  html: z.string(),
  ownerWebContentsId: z.number().int().positive(),
  instanceKey: z.string().min(1).max(1024),
});
export function createGenUiService(
  options: {
    stateRoot?: string;
    outputRoot?: string;
    registerSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  } = {},
): IGenUiService & { dispose(): void } {
  const storage = createGenUiStateStorage(
    options.stateRoot ?? join(getAppConfigDir(), "gen-ui-state"),
  );
  const runtimeId = `gen-ui:${randomUUID()}`;
  const outputRoot = options.outputRoot ?? join(getAppConfigDir(), GEN_UI_OUTPUT_DIRECTORY);
  return {
    readDocument: (target) => readGenUiDocument(target, outputRoot),
    onStateChanged: storage.onChanged,
    getState: (target) => storage.get(target),
    setState: ({ target, state }) => storage.set(target, state),
    listState: (scope) => storage.list(scope),
    dispose: () => storage.dispose(),
    async prepareSandbox(raw) {
      if (!options.registerSandbox) throw new Error("Gen UI requires a desktop sandbox");
      const input = prepareSchema.parse(raw);
      assertGenUiFragment(input.html);
      const appIdentity = createHash("sha256")
        .update(JSON.stringify(["gen-ui", buildGenUiScopeKey(input), input.path]))
        .digest("hex");
      const state = await storage.get({
        workspacePath: input.workspacePath,
        workspaceIdentity: input.workspaceIdentity,
        sessionId: input.sessionId,
        path: input.path,
      });
      const initial = JSON.stringify(state).replaceAll("<", "\\u003c");
      return options.registerSandbox({
        contentKind: "gen-ui",
        instance: { appIdentity, runtimeId, generation: 1, token: randomUUID() },
        ownerWebContentsId: input.ownerWebContentsId,
        workspacePath: input.workspacePath,
        workspaceIdentity: input.workspaceIdentity,
        sessionId: input.sessionId,
        scopeId: input.instanceKey,
        html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><!--__ZCODE_GEN_UI_STYLES__--><script type="application/json" id="zcode-gen-ui-initial-state">${initial}</script><script src="__ZCODE_GEN_UI_RUNTIME__"></script></head><body>${input.html}<!--__ZCODE_GEN_UI_INNER_KIT__--></body></html>`,
        csp: {
          connectDomains: [],
          resourceDomains: GEN_UI_STATIC_DOMAINS.map((host) => `https://${host}`),
          frameDomains: [],
          baseUriDomains: [],
        },
      });
    },
  };
}
