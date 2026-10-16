interface Verdict {
  approved: boolean;
  reason: string;
}

const paths = await files.glob("src/**/*.ts");
const verdicts = await Promise.all(
  paths.map((p) => agent("reviewer").ask<Verdict>(`Security-review ${p}`)),
);
return verdicts.filter((v) => !v.approved).map((v) => v.reason);
