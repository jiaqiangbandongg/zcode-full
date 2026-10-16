import type { DatabaseSync, SQLInputValue } from "node:sqlite";

// 独立于新版 Repo 写入，播种合法原始行；迁移不得改变这些表的任一列。
export function seedUnrelatedProviderTables(db: DatabaseSync, sessionId: string): string[] {
  const json = JSON.stringify({
    keep: "正文/附件引用",
    model: "builtin:zai/legacy",
    file: "/asset/a",
  });
  const rows: Record<string, Record<string, SQLInputValue>> = {
    todo: {
      session_id: sessionId,
      content: "待办正文",
      status: "pending",
      priority: "high",
      position: 0,
    },
    permission: { project_id: "project", data: json },
    input_history: {
      id: "history",
      project_id: "project",
      session_id: sessionId,
      text: "输入正文",
      kind: "prompt",
    },
    local_setting: {
      scope: "user",
      scope_id: "default",
      namespace: "model",
      key: "reasoningLevel",
      value: '"high"',
      schema_version: 1,
    },
    session_target: {
      session_id: sessionId,
      target_id: "goal",
      objective: "目标正文",
      status: "active",
    },
    workflow_definition: {
      id: "definition",
      name: "workflow",
      source: "user",
      script_hash: "sha",
      meta_json: json,
    },
    workflow_run: {
      id: "run",
      definition_id: "definition",
      name: "workflow",
      parent_session_id: sessionId,
      cwd: "/ws",
      script_hash: "sha",
      args_json: json,
      status: "running",
    },
    workflow_activity: {
      id: "activity",
      run_id: "run",
      call_index: 1,
      call_path: "ask",
      type: "ask",
      input_hash: "sha",
      prompt: "工作流正文",
      opts_json: json,
      status: "completed",
    },
    workflow_event: {
      id: "event",
      run_id: "run",
      sequence: 1,
      type: "completed",
      activity_id: "activity",
      payload_json: json,
    },
    session_task_link: {
      id: "link",
      root_workflow_run_id: "run",
      activity_id: "activity",
      child_session_id: sessionId,
      role: "child",
      path: "1",
      model: "builtin:zai/legacy",
      status: "completed",
    },
    model_usage: {
      id: "usage",
      logical_request_id: "request",
      session_id: sessionId,
      query_source: "agent",
      provider_id: "builtin:zai",
      model_id: "legacy",
      variant: "high",
      status: "completed",
      started_at: 1,
      raw_usage_json: json,
    },
    turn_usage: { session_id: sessionId, turn_id: "turn", status: "completed", started_at: 1 },
    tool_usage: {
      id: "tool",
      session_id: sessionId,
      tool_call_id: "call",
      tool_name: "Read",
      status: "completed",
      started_at: 1,
    },
    session_input: {
      id: "input",
      session_id: sessionId,
      kind: "prompt",
      delivery: "queue",
      payload: json,
      admitted_sequence: 1,
      status: "admitted",
    },
    dwf_run: {
      id: "dwf",
      parent_session_id: sessionId,
      caps_max_concurrency: 1,
      status: "running",
      args_json: json,
    },
    dwf_actor: {
      run_id: "dwf",
      site_id: "actor",
      ordinal: 1,
      resolved_model: json,
      persona_json: json,
    },
    dwf_node: {
      run_id: "dwf",
      site_id: "node",
      ordinal: 1,
      kind: "ask",
      input_hash: "sha",
      input_json: json,
      status: "completed",
    },
    dwf_event: { run_id: "dwf", sequence: 1, type: "completed", payload_json: json },
  };
  for (const [table, input] of Object.entries(rows)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    for (const column of columns) {
      const name = String(column.name);
      if (
        name.startsWith("time_") &&
        column.notnull &&
        column.dflt_value === null &&
        !(name in input)
      )
        input[name] = 12;
    }
    const keys = Object.keys(input);
    db.prepare(
      `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
    ).run(...Object.values(input));
  }
  return Object.keys(rows);
}
