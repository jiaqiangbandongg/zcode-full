// CreateWorkflow 的确认 gate 旁路（docs/dynamic-workflow/launch.md「The approval bypass」）。
//
// 两条硬断言：旁路**不渲染审批面板**，且**不持久化任何权限规则**。第二条是关键——
// 带上 permissionUpdates 就会把「跳过一次确认」变成真的授权，而 spec 的裁定是
// 「gate 旁路不等于权限旁路」：run 里的 actor 仍继承会话的权限 profile。
import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  type PermissionBrokerRequest,
} from "@zcode/contracts";
import { createTuiPermissionRequester } from "../src/app-permission.js";
import type { ApprovalPrompt } from "../src/app-model.js";

function permissionRequest(
  overrides: Partial<PermissionBrokerRequest> = {},
): PermissionBrokerRequest {
  return {
    toolCallId: "tc-1",
    toolName: "Bash",
    riskLevel: "low",
    reason: "needs approval",
    input: { command: "ls" },
    ...overrides,
  } as PermissionBrokerRequest;
}

/** 收集 setApprovalQueue 的每一次调用，用来证明「面板有没有被排进队列」。 */
function trackedRequester() {
  const enqueued: ApprovalPrompt[] = [];
  let statusCalls = 0;
  const requestPermission = createTuiPermissionRequester({
    setApprovalQueue: ((update: unknown) => {
      const next =
        typeof update === "function"
          ? (update as (current: ApprovalPrompt[]) => ApprovalPrompt[])([...enqueued])
          : (update as ApprovalPrompt[]);
      enqueued.length = 0;
      enqueued.push(...next);
    }) as Parameters<typeof createTuiPermissionRequester>[0]["setApprovalQueue"],
    setStatus: () => {
      statusCalls += 1;
    },
  });
  return { enqueued, requestPermission, statusCalls: () => statusCalls };
}

test("CreateWorkflow is auto-allowed without ever enqueuing an approval panel", async () => {
  const { enqueued, requestPermission, statusCalls } = trackedRequester();

  const result = await requestPermission(
    permissionRequest({ toolName: CREATE_WORKFLOW_TOOL_NAME, input: { source: "workflow {}" } }),
  );

  assert.equal(result.decision, "allow");
  // 硬断言 1：审批面板从未进队列，所以 TUI 不会闪一下审批 UI。
  assert.deepEqual(enqueued, []);
  // 面板没渲染，状态行也不该被改写成「等待审批」。
  assert.equal(statusCalls(), 0);
});

test("the CreateWorkflow bypass persists no permission rule", async () => {
  const { requestPermission } = trackedRequester();

  const result = await requestPermission(
    permissionRequest({
      toolName: CREATE_WORKFLOW_TOOL_NAME,
      // 即使服务端建议了规则，旁路也绝不把它变成持久化授权。
      suggestedPermissionUpdates: [
        { type: "addRules", behavior: "allow", rules: [{ toolName: CREATE_WORKFLOW_TOOL_NAME }] },
      ],
    } as Partial<PermissionBrokerRequest>),
  );

  assert.equal(result.decision, "allow");
  // 硬断言 2：没有任何权限规则被写回——gate 旁路 ≠ 权限旁路。
  assert.equal(result.permissionUpdates, undefined);
  assert.equal("permissionUpdates" in result && result.permissionUpdates !== undefined, false);
});

test("other tools still raise an approval panel and stay pending", async () => {
  const { enqueued, requestPermission } = trackedRequester();

  let settled = false;
  void requestPermission(permissionRequest({ toolName: "Bash" })).then(() => {
    settled = true;
  });
  // 让微任务跑一轮：如果旁路误伤了普通工具，这里就已经 resolve 了。
  await Promise.resolve();

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0]?.request.toolName, "Bash");
  assert.equal(settled, false, "a non-workflow tool must not be auto-allowed");
});

test("AskUserQuestion keeps its question-panel path", async () => {
  const { enqueued, requestPermission } = trackedRequester();

  void requestPermission(
    permissionRequest({
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      // options 的下界是 2，且每个 option 要 label + description（`value` 会被 .strict() 拒收）。
      // 给错就会走「输入非法」的 deny 分支，那样这条用例根本碰不到 question 面板路径。
      input: {
        questions: [
          {
            question: "Which approach?",
            header: "Approach",
            options: [
              { label: "A", description: "First approach" },
              { label: "B", description: "Second approach" },
            ],
          },
        ],
      },
    }),
  );
  await Promise.resolve();

  assert.equal(enqueued.length, 1);
  assert.ok(enqueued[0]?.questionState, "AskUserQuestion should still build question state");
});

test("an already-aborted request rejects before the bypass can allow it", async () => {
  const { enqueued, requestPermission } = trackedRequester();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    requestPermission(permissionRequest({ toolName: CREATE_WORKFLOW_TOOL_NAME }), {
      signal: controller.signal,
    }),
    /cancelled/u,
  );
  // 取消优先于旁路：不该因为是 CreateWorkflow 就把一个已取消的请求放行。
  assert.deepEqual(enqueued, []);
});
