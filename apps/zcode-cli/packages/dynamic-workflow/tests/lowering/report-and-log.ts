// report vs log 在同一份降级产物里各归其位：report 有站点（__host.report(siteId, item)），
// log 没有（__host.log(msg)）。这与 git.log/顶层 log 那一组是同一条判定——身份按声明，
// 不按拼写；差别只在 report 是**顶层无容器**的产生站点函数。
interface Finding {
  path: string;
  note: string;
}

const scout = agent("scout");
log("scanning");
const paths = await files.glob("src/**/*.ts");
report({ phase: "scanned", total: paths.length });

const findings: Finding[] = [];
for (const path of paths) {
  const note = await scout.ask<string>(`review ${path}`);
  report({ path, note });
  findings.push({ path, note });
}

log("done");
report({ phase: "done", total: findings.length });
return findings;
