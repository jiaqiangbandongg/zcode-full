import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
  const root = await mkdtemp(join(tmpdir(), "zcode-formal-review-"));
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

function request(id, { kind = "main", timingPolicy = "fast-text" } = {}) {
  return { id, kind, source: "capture", timingPolicy };
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
  {
    commonFixture = { version: 1, fixtures: [] },
    specSource = "it('runs', async () => {});\n",
  } = {},
) {
  const spec = `./test/e2e/conversation-session/${caseName}.test.ts`;
  const caseFixturePath = `./test/e2e/fixtures/upstream/conversation-session/${caseName}.json`;
  const defaultRequest = request(`${caseName}-request`);
  const defaultManifest = {
    version: 1,
    caseName,
    spec,
    providerFixtures: [
      "./test/e2e/fixtures/upstream/common.json",
      caseFixturePath,
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
    commonFixture,
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

test("uses the TypeScript AST for documented imports and template-expression calls", async () => {
  const root = await makeRoot();
  await addFormalCase(root, "documented-import", {
    specSource:
      "const note = `\nimport { prepareConversationE2E } from '../helpers/conversation-session.js';\n`;\n" +
      "it('documents migration', async () => note);\n",
  });
  await addFormalCase(root, "template-call", {
    specSource:
      "it('calls in interpolation', async () => `result: ${prepareConversationE2E()}`);\n",
  });

  const result = await inspect(root);

  assert.ok(
    result.formal.admitted.some(
      (item) => item.caseName === "documented-import",
    ),
  );
  assert.ok(codes(result, "template-call").includes("LEGACY_PREPARE_CALL"));
});

test("rejects absolute or traversal provider and static file fixture paths", async () => {
  const root = await makeRoot();
  const providerValues = await addFormalCase(root, "unsafe-provider");
  const absoluteProvider = join(root, "outside-provider.json");
  await writeJson(root, "outside-provider.json", { version: 1, fixtures: [] });
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/unsafe-provider.json",
    {
      ...providerValues.defaultManifest,
      providerFixtures: [
        ...providerValues.defaultManifest.providerFixtures,
        absoluteProvider,
      ],
    },
  );

  const fileValues = await addFormalCase(root, "unsafe-file");
  const absoluteFile = join(root, "outside-static-file.txt");
  await writeText(root, "outside-static-file.txt", "outside\n");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/unsafe-file.json",
    {
      ...fileValues.defaultManifest,
      fileFixtures: [absoluteFile, "./test/e2e/fixtures/../../outside.txt"],
    },
  );

  const result = await inspect(root);

  assert.ok(
    codes(result, "unsafe-provider").includes("UNSAFE_PROVIDER_FIXTURE_PATH"),
  );
  assert.ok(codes(result, "unsafe-file").includes("UNSAFE_FILE_FIXTURE_PATH"));
});

test("only exempts complete runtime file descriptors with an allowed source", async () => {
  const root = await makeRoot();
  const missing = await addFormalCase(root, "descriptor-missing-source");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/descriptor-missing-source.json",
    {
      ...missing.defaultManifest,
      fileFixtures: [{ path: "/tmp/not-enough.txt" }],
    },
  );
  const invalid = await addFormalCase(root, "descriptor-invalid-source");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/descriptor-invalid-source.json",
    {
      ...invalid.defaultManifest,
      fileFixtures: [
        {
          description: "untrusted runtime producer",
          path: "/tmp/untrusted.txt",
          source: "downloaded-from-network",
        },
      ],
    },
  );

  const result = await inspect(root);

  for (const caseName of [
    "descriptor-missing-source",
    "descriptor-invalid-source",
  ]) {
    assert.ok(
      codes(result, caseName).includes(
        "INVALID_RUNTIME_FILE_FIXTURE_DESCRIPTOR",
      ),
    );
  }
});

test("rejects incomplete provider fixture entry shapes", async () => {
  const root = await makeRoot();
  const shapes = [
    ["empty-id", { ...providerEntry(request("valid")), id: "" }],
    ["missing-match", providerEntry(request("missing-match-request"))],
    ["missing-response", providerEntry(request("missing-response-request"))],
    [
      "invalid-metadata",
      { ...providerEntry(request("invalid-metadata-request")), metadata: [] },
    ],
  ];
  delete shapes[1][1].match;
  delete shapes[2][1].response;
  for (const [caseName, fixture] of shapes) {
    const values = await addFormalCase(root, caseName);
    await writeJson(
      root,
      `packages/desktop/test/e2e/fixtures/upstream/conversation-session/${caseName}.json`,
      { version: 1, fixtures: [fixture] },
    );
    await writeJson(
      root,
      `packages/desktop/test/e2e/fixtures/cases/conversation-session/${caseName}.json`,
      {
        ...values.defaultManifest,
        requests: [request(fixture.id || `${caseName}-request`)],
      },
    );
  }

  const result = await inspect(root);

  for (const [caseName] of shapes) {
    assert.ok(
      codes(result, caseName).includes("INVALID_PROVIDER_FIXTURE_SHAPE"),
    );
  }
});

test("only allows explicit common requests from canonical common.json", async () => {
  const root = await makeRoot();
  const commonRequest = request("canonical-common", { kind: "common" });
  const valid = await addFormalCase(root, "canonical-common-valid");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/canonical-common-valid.json",
    {
      ...valid.defaultManifest,
      requests: [commonRequest, valid.defaultRequest],
    },
  );
  const wrongKindRequest = request("canonical-common-wrong-kind");
  const wrongKind = await addFormalCase(root, "canonical-common-wrong-kind");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/canonical-common-wrong-kind.json",
    {
      ...wrongKind.defaultManifest,
      requests: [wrongKindRequest, wrongKind.defaultRequest],
    },
  );
  const thirdPartyRequest = request("third-party-common", { kind: "common" });
  const thirdParty = await addFormalCase(root, "third-party-common");
  const thirdPartyPath =
    "./test/e2e/fixtures/upstream/conversation-session/other-case.json";
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/upstream/conversation-session/other-case.json",
    { version: 1, fixtures: [providerEntry(thirdPartyRequest)] },
  );
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/third-party-common.json",
    {
      ...thirdParty.defaultManifest,
      providerFixtures: [
        ...thirdParty.defaultManifest.providerFixtures,
        thirdPartyPath,
      ],
      requests: [thirdPartyRequest, thirdParty.defaultRequest],
    },
  );
  const duplicate = await addFormalCase(root, "duplicate-manifest-request");
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/cases/conversation-session/duplicate-manifest-request.json",
    {
      ...duplicate.defaultManifest,
      requests: [duplicate.defaultRequest, duplicate.defaultRequest],
    },
  );
  await writeJson(
    root,
    "packages/desktop/test/e2e/fixtures/upstream/common.json",
    {
      version: 1,
      fixtures: [providerEntry(commonRequest), providerEntry(wrongKindRequest)],
    },
  );

  const result = await inspect(root);

  assert.ok(
    result.formal.admitted.some(
      (item) => item.caseName === "canonical-common-valid",
    ),
  );
  assert.ok(
    codes(result, "canonical-common-wrong-kind").includes(
      "UNAUTHORIZED_COMMON_REQUEST",
    ),
  );
  assert.ok(
    codes(result, "third-party-common").includes("UNAUTHORIZED_COMMON_REQUEST"),
  );
  assert.ok(
    codes(result, "duplicate-manifest-request").includes(
      "DUPLICATE_MANIFEST_REQUEST_ID",
    ),
  );
});
