import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGeneratedLineEvidence } from "../marketing-source-map-evidence.mjs";

test("generated mapping evidence requires every build map to match its hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "marketing-map-evidence-"));
  try {
    await mkdir(join(root, "main"));
    const map = JSON.stringify({
      version: 3,
      names: [],
      sources: ["../source.ts"],
      sourcesContent: ["const x = 1;\nfunction removed() {}"],
      mappings: "AAAA",
    });
    await writeFile(join(root, "main/index.js.map"), map);
    const manifest = {
      schemaVersion: 1,
      status: "fresh-stable",
      domains: ["main"],
      changedFiles: [],
      outputs: { "main/index.js.map": createHash("sha256").update(map).digest("hex") },
    };
    const result = await loadGeneratedLineEvidence(root, "main", manifest);
    assert.equal(result.status, "matched");
    assert.deepEqual(result.sources[join(root, "source.ts")], [1]);
    assert.equal(
      (
        await loadGeneratedLineEvidence(root, "main", {
          ...manifest,
          outputs: { ...manifest.outputs, "main/missing.js.map": "a".repeat(64) },
        })
      ).status,
      "missing-map",
    );
    await writeFile(join(root, "main/index.js.map"), map + " ");
    assert.equal((await loadGeneratedLineEvidence(root, "main", manifest)).status, "mismatch");
    assert.equal((await loadGeneratedLineEvidence(root, "cli", manifest)).status, "unverified");
    assert.equal(
      (
        await loadGeneratedLineEvidence(root, "main", {
          ...manifest,
          status: "unverified-reused-build",
        })
      ).status,
      "unverified",
    );
    await rm(join(root, "main/index.js.map"));
    assert.equal((await loadGeneratedLineEvidence(root, "main", manifest)).status, "missing-map");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
