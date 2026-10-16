export function formatError(error, depth = 0) {
  if (!(error instanceof Error)) return String(error);
  const indent = "  ".repeat(depth);
  const fields = [];
  for (const key of ["code", "status", "statusCode", "type"]) {
    if (error[key] !== undefined) fields.push(`${key}: ${String(error[key])}`);
  }
  if (error.details !== undefined) fields.push(`details: ${truncate(JSON.stringify(error.details))}`);
  const head = `${indent}${error.stack ?? error.message}`;
  const meta = fields.length > 0 ? `\n${indent}${fields.join(`\n${indent}`)}` : "";
  const cause = error.cause ? `\n${indent}cause:\n${formatError(error.cause, depth + 1)}` : "";
  return redactSecrets(`${head}${meta}${cause}`);
}

export function formatEventDiagnostics(events) {
  const recent = events.slice(-6).map((event) => ({
    payload: event.payload ? truncate(JSON.stringify(event.payload), 800) : undefined,
    type: event.type,
  }));
  return redactSecrets(`Captured events:\n${JSON.stringify({ counts: countEventTypes(events), recent }, null, 2)}`);
}

function countEventTypes(events) {
  const counts = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}

function truncate(value, maxLength = 2000) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...<truncated>`;
}

function redactSecrets(value) {
  let output = value;
  for (const secret of [process.env.ZCODE_API_KEY]) {
    if (secret && secret.length > 8) {
      output = output.split(secret).join(`${secret.slice(0, 4)}...${secret.slice(-4)}`);
    }
  }
  return output;
}
