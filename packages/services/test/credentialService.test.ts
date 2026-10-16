import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ICredentialService } from "../src/credential/credential.js";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-credential-home-"));
  tempHomes.push(home);
  return home;
}

async function createCredentialServiceInHome(
  home: string,
  onDidMutate?: (event: { operation: "save" | "delete"; key: string }) => void,
): Promise<ICredentialService> {
  process.env.HOME = home;
  vi.resetModules();
  const mod = await import("../src/credential/credentialService.js");
  return mod.createCredentialService({ onDidMutate });
}

afterEach(() => {
  process.env.HOME = originalHome;

  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

describe("credentialService encryption", () => {
  it("notifies Host listeners only after a credential mutation is persisted", async () => {
    const home = makeTempHome();
    const onDidMutate = vi.fn();
    const service = await createCredentialServiceInHome(home, onDidMutate);

    await service.save("account-provider:demo:api-key", "secret");
    await service.delete("account-provider:demo:api-key");

    expect(onDidMutate.mock.calls).toEqual([
      [{ operation: "save", key: "account-provider:demo:api-key" }],
      [{ operation: "delete", key: "account-provider:demo:api-key" }],
    ]);
  });

  it("encrypts value before persisting and decrypts transparently on load", async () => {
    const home = makeTempHome();
    const service = await createCredentialServiceInHome(home);
    const credentialKey = "oauth:bigmodel:access_token";

    await service.save(credentialKey, "plain-access-token");

    const credentialsFile = join(home, ".zcode", "v2", "credentials.json");
    const rawStore = JSON.parse(readFileSync(credentialsFile, "utf-8")) as Record<string, string>;
    const storedValue = rawStore[credentialKey];

    expect(storedValue).toBeDefined();
    expect(storedValue).toMatch(/^enc:v1:/);
    expect(storedValue).not.toContain("plain-access-token");
    await expect(service.load(credentialKey)).resolves.toBe("plain-access-token");
  });

  it("keeps backward compatibility for legacy plaintext values", async () => {
    const home = makeTempHome();
    const credentialsDir = join(home, ".zcode", "v2");
    const credentialsFile = join(credentialsDir, "credentials.json");
    await mkdir(credentialsDir, { recursive: true });
    writeFileSync(
      credentialsFile,
      JSON.stringify({ "oauth:bigmodel:access_token": "legacy-plaintext-token" }),
      "utf-8",
    );

    const service = await createCredentialServiceInHome(home);

    await expect(service.load("oauth:bigmodel:access_token")).resolves.toBe(
      "legacy-plaintext-token",
    );
  });

  it("preserves all keys when host callers save concurrently", async () => {
    const home = makeTempHome();
    const service = await createCredentialServiceInHome(home);
    const entries = Array.from(
      { length: 30 },
      (_, index) => [`oauth:test:key-${index}`, `value-${index}`] as const,
    );

    await Promise.all(entries.map(([key, value]) => service.save(key, value)));

    await Promise.all(
      entries.map(async ([key, value]) => {
        await expect(service.load(key)).resolves.toBe(value);
      }),
    );
  });

  it("backs up corrupt JSON and refuses to erase it during save", async () => {
    const home = makeTempHome();
    const credentialsDir = join(home, ".zcode", "v2");
    const credentialsFile = join(credentialsDir, "credentials.json");
    await mkdir(credentialsDir, { recursive: true });
    writeFileSync(credentialsFile, "{not-json", "utf-8");
    const service = await createCredentialServiceInHome(home);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          expect(service.load("oauth:test:new")).rejects.toThrow("ZCode credentials are corrupt"),
        ),
      );
      await expect(service.save("oauth:test:new", "value")).rejects.toThrow(
        "ZCode credentials are corrupt",
      );
      expect(readFileSync(credentialsFile, "utf-8")).toBe("{not-json");
      const backups = readdirSync(credentialsDir).filter((file) =>
        /^credentials\.json\.corrupt-.*\.bak$/.test(file),
      );
      expect(backups).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[credentialService"),
        "read failed; refusing to overwrite corrupt credential store",
        expect.objectContaining({ credentialsFile }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
