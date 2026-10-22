export interface SessionRow {
  id: string;
  project_id: string;
  workspace_id: string | null;
  parent_id: string | null;
  trace_id: string | null;
  task_type: string;
  slug: string;
  directory: string;
  path: string | null;
  title: string;
  title_source: string | null;
  title_message_id: string | null;
  version: string;
  share_url: string | null;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
  summary_diffs: string | null;
  revert: string | null;
  permission: string | null;
  time_created: number;
  time_updated: number;
  time_title_updated: number | null;
  time_compacting: number | null;
  time_archived: number | null;
  time_deleted: number | null;
  last_outcome: "completed" | "error" | "interrupted" | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  sequence: number | null;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  sequence: number | null;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface SessionEntryRow {
  id: string;
  session_id: string;
  type: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface TodoRow {
  session_id: string;
  content: string;
  status: string;
  priority: string;
  position: number;
  time_created: number;
  time_updated: number;
}

export interface PermissionRow {
  project_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface LocalSettingRow {
  value: string;
}

export interface InputHistoryRow {
  id: string;
  project_id: string;
  session_id: string | null;
  text: string;
  attachments: string | null;
  kind: string;
  time_created: number;
}
