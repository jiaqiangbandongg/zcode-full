import ora from "ora";

function normalizeTaskName(taskName) {
  const normalized = String(taskName || "").trim();
  if (normalized === "") {
    throw new Error("taskName is required");
  }
  return normalized;
}

export function createStatusPrinter(taskName) {
  const normalizedTaskName = normalizeTaskName(taskName);
  const spinner = ora({ isEnabled: true, stream: process.stderr });

  return {
    start(status = "进行中") {
      spinner.start(`${normalizedTaskName} ${String(status).trim()}`);
    },
    succeed(status = "完成") {
      spinner.succeed(`${normalizedTaskName} ${String(status).trim()}`);
    },
    fail(status = "失败") {
      spinner.fail(`${normalizedTaskName} ${String(status).trim()}`);
    },
  };
}
