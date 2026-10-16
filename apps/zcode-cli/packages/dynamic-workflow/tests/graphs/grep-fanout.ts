interface Finding {
  path: string;
  severity: string;
}

// grep result fanned out over asks: the world-read site is a source node and each ask
// carries a data edge from it, exactly as glob-fanout asserts for files.glob.
const hits = await files.grep("eval\\(", "*.ts");
const findings = await Promise.all(
  hits.map((hit) =>
    agent("auditor").ask<Finding>(`Assess ${hit.path}:${hit.line} — ${hit.text}`),
  ),
);
return findings.filter((f) => f.severity !== "none").map((f) => f.path);
