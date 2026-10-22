import { createHash } from "node:crypto";
import path from "node:path";

import { isException, isSourceFile, moduleForFile, posix } from "./policy.mjs";

function fingerprint(rule, file, detail = "") {
  return createHash("sha256").update(`${rule}\0${file}\0${detail}`).digest("hex").slice(0, 16);
}

/**
 * 违规文件路径统一为相对 cwd 的 posix 路径。修复原因：首版写入绝对路径，fingerprint 随之含机器
 * 路径，baseline 在 CI 与不同开发机之间永远对不上（首版 baseline 为空所以没暴露）。
 */
export function violation({
  rule,
  file,
  detail,
  message,
  module,
  global = false,
  cwd = process.cwd(),
}) {
  const relative = path.isAbsolute(file) ? posix(path.relative(cwd, file)) : posix(file);
  const relativeDetail =
    typeof detail === "string" && path.isAbsolute(detail) && detail.startsWith(cwd)
      ? posix(path.relative(cwd, detail))
      : detail;
  return {
    rule,
    file: relative,
    module: module?.id ?? null,
    detail: relativeDetail,
    message,
    fingerprint: fingerprint(rule, relative, relativeDetail),
    global,
  };
}

export function cycleViolations(edges, policy, modulesByFile, cwd) {
  const state = new Map();
  const stack = [];
  const cycles = [];
  function visit(node) {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      if (!modulesByFile.get(next)?.managed && policy.global.managedOnly) continue;
      if (state.get(next) === 1) {
        const index = stack.indexOf(next);
        cycles.push(stack.slice(index).concat(next));
      } else if (!state.get(next)) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  }
  for (const node of edges.keys()) if (!state.get(node)) visit(node);
  const unique = new Map();
  for (const cycle of cycles) {
    const detail = [...new Set(cycle)]
      .map((item) => posix(path.relative(cwd, item)))
      .sort()
      .join(" -> ");
    const file = cycle[0];
    unique.set(
      detail,
      violation({
        rule: "cycle",
        file,
        detail,
        module: modulesByFile.get(file),
        message: `检测到循环依赖：${cycle.map((item) => posix(path.relative(cwd, item))).join(" -> ")}`,
        global: true,
        cwd,
      }),
    );
  }
  return [...unique.values()];
}

const TEST_LIKE =
  /(\.(test|spec|stories)\.[cm]?[jt]sx?|\.d\.ts)$|(^|\/)(test|tests|__tests__|e2e|__mocks__|fixtures|scripts)\//;

/**
 * unmanaged-new-file：新增源码文件必须属于 managed 模块。
 * 修复原因：首版 `managedOnly: true` 下，新文件只要写进 legacy 根目录（如 packages/ui/src/）就
 * 跳过全部规则，"新代码走这套约束"没有任何机械保证；实测在 ui 根目录新建文件深导入
 * services 实现，0 违规。测试、类型声明与测试目录不在此列，避免把测试也逼进 managed 模块。
 */
export function unmanagedNewFileViolations(addedFiles, policy, cwd) {
  if (!policy.global.newFilesRequireManagedModule) return [];
  const violations = [];
  for (const relative of addedFiles) {
    const normalized = posix(relative);
    if (!isSourceFile(normalized) || TEST_LIKE.test(normalized)) continue;
    if (!policy.global.newFileScopes.some((scope) => normalized.startsWith(`${scope}/`))) continue;
    if (isException(policy, "unmanaged-new-file", path.resolve(cwd, relative), cwd)) continue;
    const module = moduleForFile(path.resolve(cwd, relative), policy);
    if (module?.managed) continue;
    violations.push(
      violation({
        cwd,
        rule: "unmanaged-new-file",
        file: path.resolve(cwd, relative),
        detail: module?.id ?? "unregistered",
        module,
        message: module
          ? `新文件落在未受管模块 ${module.id}；请放入 managed 模块，或用 pnpm architecture:adopt <id> --root <dir> 为它所在目录登记模块`
          : "新文件不属于任何已登记模块；请用 pnpm architecture:adopt <id> --root <dir> 登记后再提交",
      }),
    );
  }
  return violations;
}
