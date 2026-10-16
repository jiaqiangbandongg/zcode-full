import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as notices from "./third-party-notices.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const noticeText = "Copyright Example Authors\nMIT license text\n";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zcode-notices-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, notices.noticesFileName), noticeText);
  return root;
}

async function writeJson(root, file, value) {
  await writeFile(join(root, file), JSON.stringify(value));
}

async function inventory(root, overrides = {}) {
  await mkdir(join(root, "third-party"), { recursive: true });
  await writeJson(root, "third-party/inventory.json", {
    schemaVersion: 1,
    noticesSha256: hash(noticeText),
    inputs: {},
    reviewRequired: [],
    ...overrides,
  });
}

async function assertBuildOutputs(root) {
  const destination = join(root, "dist");
  await notices.stageThirdPartyNotices(destination, root);
  assert.equal(await readFile(join(destination, notices.noticesFileName), "utf8"), noticeText);
  const assets = [];
  const plugin = notices.thirdPartyNoticesVitePlugin(root);
  plugin.configResolved({ base: "/app/" });
  await plugin.generateBundle.call({ emitFile: (asset) => assets.push(asset) });
  assert.equal(assets.length, 1);
  assert.equal(assets[0].fileName, notices.noticesFileName);
  assert.equal(assets[0].source.toString("utf8"), noticeText);
  assert.equal(
    plugin.transformIndexHtml.handler()[0].attrs.href,
    `/app/${notices.noticesFileName}`,
  );
}

test("build copies and emits notices without an inventory", async (t) => {
  const root = await fixture(t);
  await assertBuildOutputs(root);
});

test("editing a registered skill does not block build but explicit verification fails", async (t) => {
  const root = await fixture(t);
  const file = ".agents/skills/agent-browser/SKILL.md";
  await mkdir(join(root, ".agents/skills/agent-browser"), { recursive: true });
  await writeFile(join(root, file), "updated skill\n");
  await inventory(root, { inputs: { [file]: hash("old skill\n") } });
  await assertBuildOutputs(root);
  await assert.rejects(notices.readVerifiedNotices(root), /Third-party input changed/u);
});

test("changed notices can be packaged while explicit verification detects the mismatch", async (t) => {
  const root = await fixture(t);
  await inventory(root, { noticesSha256: hash("previous notices") });
  await assertBuildOutputs(root);
  await assert.rejects(notices.readVerifiedNotices(root), /Third-party notices changed/u);
});

test("strict release verification still rejects unresolved materials", async (t) => {
  const root = await fixture(t);
  await inventory(root, { reviewRequired: [{ id: "example", reason: "pending review" }] });
  await assertBuildOutputs(root);
  assert.equal((await notices.readVerifiedNotices(root)).toString("utf8"), noticeText);
  await assert.rejects(
    notices.readVerifiedNotices(root, { requireComplete: true }),
    /Unresolved third-party material obligations/u,
  );
});

test("Node staging copies existing text without enforcing its recorded hash", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "third-party/runtime"), { recursive: true });
  const source = { version: "24.14.0", file: "LICENSE.node.txt", sha256: hash("old text") };
  await writeJson(root, "third-party/runtime/sources.json", { node: [source] });
  await writeFile(join(root, source.file), noticeText);
  const destination = join(root, "node");
  await notices.stageNodeNotices(destination, source.version, root);
  assert.equal(await readFile(join(destination, "LICENSE.node.txt"), "utf8"), noticeText);
  assert.deepEqual(
    JSON.parse(await readFile(join(destination, "NODE-SOURCES.json"), "utf8")),
    source,
  );
});

test("native staging tolerates stale inputs, hashes and provenance while explicit generation verifies", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "third-party/native-search"), { recursive: true });
  await writeFile(join(root, "native-config.json"), "updated versions");
  const material = {
    inputs: { "native-config.json": hash("old versions") },
    scope: "fixture",
    components: [
      {
        id: "ripgrep",
        version: "1.0.0",
        notices: [{ file: notices.noticesFileName, sha256: hash("old notice") }],
      },
    ],
    archives: [],
  };
  await writeJson(root, "third-party/native-search/sources.json", material);
  const binaryPath = join(root, "rg");
  await writeFile(binaryPath, "fixture binary");
  const plan = {
    artifacts: [{ toolId: "ripgrep", version: "2.0.0", binaryPath, archiveSha256: "unregistered" }],
  };
  for (const builtFromSource of [false, true]) {
    await notices.stageNativeSearchNotices(plan, root, { builtFromSource });
    assert.ok((await readFile(join(root, "THIRD-PARTY-NOTICES.txt"), "utf8")).includes(noticeText));
    const staged = JSON.parse(await readFile(join(root, "SOURCES.json"), "utf8"));
    assert.equal(staged.binary.version, "2.0.0");
    assert.equal(staged.binary.sha256, hash("fixture binary"));
  }
  await assert.rejects(
    notices.readNativeSearchNotices(root, { verify: true }),
    /Native license versions changed/u,
  );
  material.inputs = {};
  await writeJson(root, "third-party/native-search/sources.json", material);
  await assert.rejects(
    notices.readNativeSearchNotices(root, { verify: true }),
    /Changed native notice/u,
  );
});

test("missing notices still surface the underlying file error", async (t) => {
  const root = await fixture(t);
  await rm(join(root, notices.noticesFileName));
  await assert.rejects(notices.stageThirdPartyNotices(join(root, "dist"), root), {
    code: "ENOENT",
  });
});
