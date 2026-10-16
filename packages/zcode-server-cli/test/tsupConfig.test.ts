import { describe, expect, it } from "vitest";
import { SERVER_CLI_DEFINES } from "../tsup.config.js";
import { loadBuiltinProviderConfig } from "../../../scripts/builtin-provider-config.mjs";

describe("server cli tsup config", () => {
  it("embeds the selected environment's Built-in config used by Server Core", async () => {
    const expected = await loadBuiltinProviderConfig();
    expect(JSON.parse(SERVER_CLI_DEFINES.__ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__)).toBe(
      expected.content,
    );
  });
});
