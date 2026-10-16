import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { inspectConversationSessionFormalAdmission as inspect } from "../lib/conversation-session-formal-admission.mjs";

const temporaryRoots = [];

after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "zcode-formal-review-2-"));
  temporaryRoots.push(root);
  return root;
}

async function writeText(root, relativePath, value) {
  const absolutePath = join(root, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, value, "utf8");
}

async function writeJson(root, relativePath, value) {
  await writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function request(id) {
  return {
    id,
    kind: "main",
    source: "capture",
    timingPolicy: "fast-text",
  };
}

function providerEntry(manifestRequest) {
  const { id, ...metadata } = manifestRequest;
  return {
    id,
    match: { method: "POST", pathIncludes: "/messages" },
    metadata,
    response: { statusCode: 200, text: { text: "ok" } },
  };
}

async function addFormalCase(
  root,
  caseName,
  specSource = "it('runs', async () => {});\n",
) {
  const defaultRequest = request(`${caseName}-request`);
  const defaultManifest = {
    version: 1,
    caseName,
    spec: `./test/e2e/conversation-session/${caseName}.test.ts`,
    providerFixtures: [
      "./test/e2e/fixtures/upstream/common.json",
      `./test/e2e/fixtures/upstream/conversation-session/${caseName}.json`,
    ],
    fileFixtures: [],
    requests: [defaultRequest],
  };
  await writeText(
    root,
    `packages/desktop/test/e2e/conversation-session/${caseName}.test.ts`,
    specSource,
  );
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/upstream/common.json",
    {
      version: 1,
      fixtures: [],
    },
  );
  await writeJson(
    root,
    `packages/desktop/test/e2e/fixtures/upstream/conversation-session/${caseName}.json`,
    { version: 1, fixtures: [providerEntry(defaultRequest)] },
  );
  await writeJson(
    root,
    `packages/desktop/test/e2e/fixtures/cases/conversation-session/${caseName}.json`,
    defaultManifest,
  );
  return { defaultManifest, defaultRequest };
}

function codes(result, caseName) {
  return (
    result.formal.rejected.find((item) => item.caseName === caseName)
      ?.reasons ?? []
  ).map((reason) => reason.code);
}

test("rejects provider and static file symlinks that escape trusted roots", async () => {
  const root = await makeRoot();
  const provider = await addFormalCase(root, "provider-symlink-escape");
  await writeJson(root, "outside-provider.json", { version: 1, fixtures: [] });
  const providerLink =
    "packages/desktop/test/e2e/fixtures/upstream/provider-link.json";
  await symlink(join(root, "outside-provider.json"), join(root, providerLink));
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/provider-symlink-escape.json",
    {
      ...provider.defaultManifest,
      providerFixtures: [
        ...provider.defaultManifest.providerFixtures,
        "./test/e2e/fixtures/upstream/provider-link.json",
      ],
    },
  );

  const staticFile = await addFormalCase(root, "static-symlink-escape");
  await writeText(root, "outside-static.txt", "outside\n");
  const staticLink = "packages/desktop/test/e2e/fixtures/fs/static-link.txt";
  await mkdir(dirname(join(root, staticLink)), { recursive: true });
  await symlink(join(root, "outside-static.txt"), join(root, staticLink));
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/static-symlink-escape.json",
    {
      ...staticFile.defaultManifest,
      fileFixtures: ["./test/e2e/fixtures/fs/static-link.txt"],
    },
  );

  const result = await inspect(root);

  assert.ok(
    codes(result, "provider-symlink-escape").includes(
      "UNSAFE_PROVIDER_FIXTURE_PATH",
    ),
  );
  assert.ok(
    codes(result, "static-symlink-escape").includes("UNSAFE_FILE_FIXTURE_PATH"),
  );
});

test("requires providerRequestPolicy none for an empty case-local contract", async () => {
  const root = await makeRoot();
  const implicit = await addFormalCase(root, "implicit-empty-contract");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/upstream/conversation-session/implicit-empty-contract.json",
    { version: 1, fixtures: [] },
  );
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/implicit-empty-contract.json",
    { ...implicit.defaultManifest, requests: [] },
  );

  const explicit = await addFormalCase(root, "explicit-empty-contract");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/upstream/conversation-session/explicit-empty-contract.json",
    { version: 1, fixtures: [] },
  );
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/explicit-empty-contract.json",
    {
      ...explicit.defaultManifest,
      providerRequestPolicy: "none",
      requests: [],
    },
  );

  const result = await inspect(root);

  assert.ok(
    codes(result, "implicit-empty-contract").includes(
      "EMPTY_CASE_FIXTURE_WITHOUT_NONE",
    ),
  );
  assert.ok(
    result.formal.admitted.some(
      (item) => item.caseName === "explicit-empty-contract",
    ),
  );
});

test("unwraps syntax-transparent AST wrappers around legacy prepare calls", async () => {
  const root = await makeRoot();
  const cases = [
    ["parenthesized-call", "(prepareConversationE2E)();"],
    ["non-null-call", "prepareConversationE2E!();"],
    [
      "as-satisfies-call",
      "((prepareConversationE2E as unknown) satisfies unknown)();",
    ],
  ];
  for (const [caseName, call] of cases) {
    await addFormalCase(
      root,
      caseName,
      `it('calls wrapped legacy helper', async () => { ${call} });\n`,
    );
  }

  const result = await inspect(root);

  for (const [caseName] of cases) {
    assert.ok(codes(result, caseName).includes("LEGACY_PREPARE_CALL"));
  }
});
