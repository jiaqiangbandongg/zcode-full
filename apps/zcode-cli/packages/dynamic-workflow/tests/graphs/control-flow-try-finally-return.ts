// try/finally where the FINALLY return wins at runtime and carries the taint.
const a = await agent("a").ask("alpha");
try {
  return "literal";
} finally {
  return `finally: ${a}`;
}
