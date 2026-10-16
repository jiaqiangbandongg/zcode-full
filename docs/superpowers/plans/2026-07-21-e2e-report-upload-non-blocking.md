# E2E Report Upload Non-Blocking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除 `ZCODE_E2E_REPORT_UPLOAD_REQUIRED` 强制门禁，让报告平台上传失败只告警，同时保留 E2E 和 summary 校验失败语义。

**Architecture:** macOS Bash 与 Windows PowerShell job 继续在主 `script` 中先保存测试状态并尝试上传，确保失败场景仍有诊断材料。最终退出码只读取 E2E/summary 校验结果，不再读取报告平台上传状态；用 CI 配置静态测试锁定两个平台的一致行为。

**Tech Stack:** GitLab CI YAML、Bash、PowerShell、Vitest、TypeScript

## Global Constraints

- 只修改 CI 编排、CI 静态测试和现有报告上传 spec，不改产品运行时代码。
- 报告平台 token 缺失、网络失败、`4xx/5xx` 或超时不得使 CI job 失败。
- E2E 或 summary 校验失败时仍须失败，并且上传尝试必须发生在返回 E2E 退出码之前。
- macOS 与 Windows job 保持相同语义。

---

### Task 1: 锁定非阻塞上传契约

**Files:**
- Modify: `packages/desktop/test/gitlabCiBuildGraph.test.ts:149`
- Test: `packages/desktop/test/gitlabCiBuildGraph.test.ts`

**Interfaces:**
- Consumes: `.gitlab/ci/20-test.yml` 中两个 conversation-session E2E job 的文本。
- Produces: 保留上传位置与失败视频配置、禁止 `ZCODE_E2E_REPORT_UPLOAD_REQUIRED` 的静态契约。

- [x] **Step 1: Write the failing test**

将 case 名称改为 `collects failure videos without making report upload a CI gate`，并对两个 job 添加：

```ts
expect(macE2EJob).not.toContain("ZCODE_E2E_REPORT_UPLOAD_REQUIRED");
expect(windowsE2EJob).not.toContain("ZCODE_E2E_REPORT_UPLOAD_REQUIRED");
```

保留 uploader 位于 E2E exit 之前、没有 `after_script`、失败视频开关存在的断言。

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/desktop/test/gitlabCiBuildGraph.test.ts -t "collects failure videos"`

Expected: FAIL，指出两个 job 仍包含 `ZCODE_E2E_REPORT_UPLOAD_REQUIRED`。

### Task 2: 移除两个平台的强制上传门禁

**Files:**
- Modify: `.gitlab/ci/20-test.yml:189`
- Test: `packages/desktop/test/gitlabCiBuildGraph.test.ts`

**Interfaces:**
- Consumes: Task 1 的静态契约。
- Produces: 报告上传状态仅用于 warning，job 最终状态只由 `$e2e_status` / `$e2eStatus` 决定。

- [x] **Step 1: Write minimal implementation**

删除两个 job variables 中的：

```yaml
ZCODE_E2E_REPORT_UPLOAD_REQUIRED: "1"
```

并删除 macOS：

```bash
if [[ "${ZCODE_E2E_REPORT_UPLOAD_REQUIRED:-}" == "1" && "$report_upload_status" -ne 0 ]]; then
  exit "$report_upload_status"
fi
```

删除 Windows：

```powershell
if ($env:ZCODE_E2E_REPORT_UPLOAD_REQUIRED -eq "1" -and $reportUploadStatus -ne 0) {
  exit $reportUploadStatus
}
```

在两个 job 保留中文原因注释：外部报告平台属于诊断链路，其状态不得覆盖测试与 summary 校验结果。

- [x] **Step 2: Run focused tests to verify they pass**

Run: `pnpm exec vitest run packages/desktop/test/gitlabCiBuildGraph.test.ts -t "collects failure videos"`

Run: `pnpm exec vitest run packages/desktop/test/ciPushE2eReportToFeedback.test.ts`

Expected: PASS。

- [ ] **Step 3: Verify repository gates**

Run: `pnpm --filter @zcode/desktop typecheck:e2e`

Run: `pnpm typecheck`

Run: `pnpm lint`

Expected: 所有命令退出码为 0。

- [ ] **Step 4: Commit**

```bash
git add .gitlab/ci/20-test.yml packages/desktop/test/gitlabCiBuildGraph.test.ts docs/superpowers/plans/2026-07-21-e2e-report-upload-non-blocking.md
git commit -m "fix(ci): make e2e report upload non-blocking"
```
