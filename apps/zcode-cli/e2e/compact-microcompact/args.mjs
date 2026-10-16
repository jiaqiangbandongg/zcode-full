import { CASE_NAMES, FAKE_CASE_NAMES, REAL_CASE_NAMES } from "./constants.mjs";

export function parseArgs(args) {
  const options = {
    artifactsDir: undefined,
    baseURL: undefined,
    cases: ["all"],
    dryRun: false,
    keepTmp: false,
    model: undefined,
  };

  for (const arg of args) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--keep-tmp") {
      options.keepTmp = true;
      continue;
    }
    if (arg.startsWith("--artifacts-dir=")) {
      options.artifactsDir = nonEmptyArgValue(arg, "--artifacts-dir=");
      continue;
    }
    if (arg.startsWith("--case=")) {
      options.cases = parseCaseList(nonEmptyArgValue(arg, "--case="));
      continue;
    }
    if (arg.startsWith("--model=")) {
      options.model = nonEmptyArgValue(arg, "--model=");
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      options.baseURL = nonEmptyArgValue(arg, "--base-url=");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function resolveCaseNames(requested) {
  const names = new Set();
  for (const name of requested) {
    if (name === "all") {
      CASE_NAMES.forEach((caseName) => names.add(caseName));
      continue;
    }
    if (name === "real") {
      REAL_CASE_NAMES.forEach((caseName) => names.add(caseName));
      continue;
    }
    if (name === "fake") {
      FAKE_CASE_NAMES.forEach((caseName) => names.add(caseName));
      continue;
    }
    if (!CASE_NAMES.includes(name)) {
      throw new Error(`Unknown case: ${name}. Available cases: ${CASE_NAMES.join(", ")}`);
    }
    names.add(name);
  }
  return [...names];
}

function parseCaseList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function nonEmptyArgValue(arg, prefix) {
  const value = arg.slice(prefix.length).trim();
  if (!value) throw new Error(`Missing value for ${prefix.slice(0, -1)}`);
  return value;
}
