export function formatReport(result, { base = null } = {}) {
  const lines = [
    `architecture: ${result.newViolations.length === 0 ? "OK" : "FAILED"}`,
    ...(base ? [`base: ${base}`] : []),
    `violations: ${result.violations.length}`,
    `baseline: ${result.baselineViolations.length}`,
    `new: ${result.newViolations.length}`,
  ];
  for (const item of result.newViolations)
    lines.push(`- ${item.rule} ${item.file}: ${item.message}`);
  return lines.join("\n");
}

export function formatMarkdownReport(result) {
  const lines = [
    `# Architecture report`,
    "",
    `- Status: **${result.newViolations.length === 0 ? "OK" : "FAILED"}**`,
    `- Violations: ${result.violations.length}`,
    `- Baseline: ${result.baselineViolations.length}`,
    `- New: ${result.newViolations.length}`,
  ];
  if (result.newViolations.length > 0) {
    lines.push("", "## New violations", "", "| Rule | File | Message |", "| --- | --- | --- |");
    for (const item of result.newViolations)
      lines.push(`| ${item.rule} | ${item.file} | ${item.message.replaceAll("|", "\\|")} |`);
  }
  return lines.join("\n");
}
