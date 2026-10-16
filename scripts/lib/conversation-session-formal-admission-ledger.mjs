import {
  diagnostic,
  isRecord,
} from "./conversation-session-formal-admission-utils.mjs";

const REQUEST_METADATA_FIELDS = [
  "kind",
  "source",
  "timingPolicy",
  "syntheticReason",
];

export function validateRequestLedger({
  caseFixtures,
  manifestSubjectPath,
  providerFiles,
  reasons,
  requests,
  specPath,
}) {
  const allFixturesById = new Map();
  for (const providerFile of providerFiles) {
    for (const fixture of providerFile.fixtures) {
      if (allFixturesById.has(fixture.id)) {
        reasons.push(
          diagnostic({
            code: "DUPLICATE_PROVIDER_REQUEST_ID",
            message: `provider request id ${fixture.id} is declared by more than one provider fixture`,
            specPath,
            subjectPath: providerFile.subjectPath,
          }),
        );
      } else {
        allFixturesById.set(fixture.id, { fixture, providerFile });
      }
    }
  }

  const caseIds = caseFixtures.map((fixture) => fixture.id);
  const caseIdSet = new Set(caseIds);
  const allowedFixturesById = new Map(
    caseFixtures.map((fixture) => [fixture.id, fixture]),
  );
  for (const providerFile of providerFiles) {
    if (!providerFile.isCanonicalCommon) {
      continue;
    }
    for (const fixture of providerFile.fixtures) {
      if (fixture.metadata.kind === "common") {
        allowedFixturesById.set(fixture.id, fixture);
      }
    }
  }
  const requestIds = requests.map((request) => request.id);
  const manifestCaseIds = requestIds.filter((id) => caseIdSet.has(id));
  const inventedIds = requestIds.filter((id) => !allFixturesById.has(id));
  const unauthorizedIds = requestIds.filter(
    (id) => allFixturesById.has(id) && !allowedFixturesById.has(id),
  );
  const missingIds = caseIds.filter((id) => !requestIds.includes(id));
  if (inventedIds.length > 0 || missingIds.length > 0) {
    reasons.push(
      diagnostic({
        code: "REQUEST_LEDGER_ID_MISMATCH",
        message:
          `request ledger IDs do not match declared fixtures; ` +
          `invented=[${inventedIds.join(", ")}], missing case-local=[${missingIds.join(", ")}]`,
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
  }
  if (unauthorizedIds.length > 0) {
    reasons.push(
      diagnostic({
        code: "UNAUTHORIZED_COMMON_REQUEST",
        message:
          "non-case requests must come from canonical common.json with metadata.kind=common; " +
          `unauthorized=[${unauthorizedIds.join(", ")}]`,
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
  }
  if (
    inventedIds.length === 0 &&
    missingIds.length === 0 &&
    unauthorizedIds.length === 0 &&
    !arraysEqual(manifestCaseIds, caseIds)
  ) {
    reasons.push(
      diagnostic({
        code: "REQUEST_LEDGER_ORDER_MISMATCH",
        message:
          `case-local request order must be [${caseIds.join(", ")}]; ` +
          `received [${manifestCaseIds.join(", ")}]`,
        specPath,
        subjectPath: manifestSubjectPath,
      }),
    );
  }

  for (const request of requests) {
    const fixture = allowedFixturesById.get(request.id);
    if (!fixture) {
      continue;
    }
    for (const field of REQUEST_METADATA_FIELDS) {
      const fixtureValue = isRecord(fixture.metadata)
        ? fixture.metadata[field]
        : undefined;
      if (request[field] !== fixtureValue) {
        reasons.push(
          diagnostic({
            code: "REQUEST_LEDGER_METADATA_MISMATCH",
            message:
              `request ${request.id} metadata.${field} must match its provider fixture; ` +
              `manifest=${JSON.stringify(request[field])}, fixture=${JSON.stringify(fixtureValue)}`,
            specPath,
            subjectPath: manifestSubjectPath,
          }),
        );
      }
    }
  }
}

export function validateProviderFixture(
  value,
  subjectPath,
  specPath,
  reasons,
  { reportShapeError = true } = {},
) {
  if (value === undefined) {
    return null;
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.fixtures)
  ) {
    if (reportShapeError) {
      reasons.push(
        diagnostic({
          code: "INVALID_PROVIDER_FIXTURE_SHAPE",
          message: "provider fixture must have version 1 and a fixtures array",
          specPath,
          subjectPath,
        }),
      );
    }
    return null;
  }
  const valid = [];
  for (const fixture of value.fixtures) {
    if (
      !isRecord(fixture) ||
      typeof fixture.id !== "string" ||
      fixture.id.trim().length === 0 ||
      !isRecord(fixture.match) ||
      !isRecord(fixture.response) ||
      !isProviderMetadata(fixture.metadata)
    ) {
      reasons.push(
        diagnostic({
          code: "INVALID_PROVIDER_FIXTURE_SHAPE",
          message:
            "each provider fixture request requires a non-empty id and object match/response/metadata fields",
          specPath,
          subjectPath,
        }),
      );
      continue;
    }
    valid.push(fixture);
  }
  return valid;
}

export function validateRequestArray(value, subjectPath, specPath, reasons) {
  if (!Array.isArray(value)) {
    reasons.push(
      diagnostic({
        code: "INVALID_MANIFEST_SHAPE",
        message: "case manifest requests must be an array",
        specPath,
        subjectPath,
      }),
    );
    return null;
  }
  const requests = [];
  const seenIds = new Set();
  for (const request of value) {
    if (
      !isRecord(request) ||
      typeof request.id !== "string" ||
      request.id.trim().length === 0
    ) {
      reasons.push(
        diagnostic({
          code: "INVALID_MANIFEST_SHAPE",
          message: "each manifest request must have a string id",
          specPath,
          subjectPath,
        }),
      );
      continue;
    }
    if (seenIds.has(request.id)) {
      reasons.push(
        diagnostic({
          code: "DUPLICATE_MANIFEST_REQUEST_ID",
          message: `manifest request id ${request.id} is declared more than once`,
          specPath,
          subjectPath,
        }),
      );
    }
    seenIds.add(request.id);
    requests.push(request);
  }
  return requests.length === value.length ? requests : null;
}

function isProviderMetadata(value) {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    value.kind.trim().length > 0 &&
    typeof value.source === "string" &&
    value.source.trim().length > 0 &&
    typeof value.timingPolicy === "string" &&
    value.timingPolicy.trim().length > 0 &&
    (value.syntheticReason === undefined ||
      typeof value.syntheticReason === "string")
  );
}

export function validateSyntheticReasons(
  requests,
  subjectPath,
  specPath,
  reasons,
) {
  for (const request of requests) {
    if (
      (request.kind === "synthetic" || request.source === "synthetic") &&
      (typeof request.syntheticReason !== "string" ||
        request.syntheticReason.trim().length === 0)
    ) {
      reasons.push(
        diagnostic({
          code: "SYNTHETIC_REASON_MISSING",
          message: `synthetic request ${request.id ?? "<missing-id>"} requires a non-empty syntheticReason`,
          specPath,
          subjectPath,
        }),
      );
    }
  }
}

function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
