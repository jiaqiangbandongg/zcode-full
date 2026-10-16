export function buildFormalAdmissionAuditIntegration(formalAdmission) {
  const errors = [];
  for (const rejected of formalAdmission.formal.rejected) {
    for (const reason of rejected.reasons) {
      errors.push(
        `formal admission rejected ${rejected.specPath}: ${reason.code}: ${reason.message} (${reason.subjectPath})`,
      );
    }
  }
  for (const pending of formalAdmission.pending) {
    for (const reason of pending.reasons ?? []) {
      errors.push(
        `pending fixture metadata rejected ${pending.specPath}: ${reason.code}: ${reason.message} (${reason.subjectPath})`,
      );
    }
  }
  const counts = formalAdmission.counts;
  return {
    errors,
    json: formalAdmission,
    text: [
      `formal admission: ${counts.formalAdmitted} admitted, ${counts.formalRejected} rejected`,
      `manual review inventory: ${counts.pending} pending`,
      `pending fixture metadata: ${counts.pendingFixtureRejected} rejected`,
      `formal contract gaps: ${counts.missingManifest} missing manifest, ${counts.missingFixture} missing case fixture`,
      `legacy harness inventory: ${counts.legacyHarness} total (${counts.legacyHarnessFormal} formal, ${counts.legacyHarnessPending} pending)`,
    ],
  };
}

export function getCoverageAuditExitCode(check, errors) {
  return check && errors.length > 0 ? 1 : 0;
}
