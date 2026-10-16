import { describe, expect, it } from "vitest";
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  getStorageCleanScopes,
  isProtectedStoragePath,
  type StorageCatalogContext,
} from "../src/storage/domain/storageCatalog.js";
import { STORAGE_CATEGORY_IDS } from "@zcode/shared";

const home: StorageCatalogContext = { rootId: "home", hasCustomDataBaseDir: false };

describe("classifyStoragePath", () => {
  it.each([
    ["v2/tasks-index.sqlite", "sessionStore", "v2/tasks-index.sqlite"],
    ["v2/tasks-index.sqlite-wal", "sessionStore", "v2/tasks-index.sqlite-wal"],
    ["cli/db/db.sqlite", "sessionStore", "cli/db/db.sqlite"],
    ["cli/db/db.sqlite-shm", "sessionStore", "cli/db/db.sqlite-shm"],
    ["v2/sessions/abc/task.json", "sessionStore", "v2/sessions/abc"],
    ["v2/checkpoints/ws/a/pending/x.bin", "toolOutputs", "v2/checkpoints/ws/a/pending/x.bin"],
    ["cli/artifacts/sess_1/call.json", "toolOutputs", "cli/artifacts/sess_1"],
    ["cli/agents/sess_1/agent_1/transcript.jsonl", "subagentTranscripts", "cli/agents/sess_1"],
    ["cli/agents/sess_1/agent_1/output.txt", "toolOutputs", "cli/agents/sess_1"],
    ["cli/agents/sess_1/agent_1/metadata.json", "toolOutputs", "cli/agents/sess_1"],
    ["cli/debug/model-io-sess_x.jsonl", "modelTrajectory", "cli/debug/model-io-sess_x.jsonl"],
    ["cli/rollout/model-io-sess_x.jsonl", "modelTrajectory", "cli/rollout/model-io-sess_x.jsonl"],
    ["v2/dev/stdio-traffic/abc/x.ndjson", "devTraces", "v2/dev/stdio-traffic"],
    ["v2/acp-traffic-proxy/captures/t.ndjson", "devTraces", "v2/acp-traffic-proxy/captures"],
    ["v2/logs/2026-09-04.log", "logs", "v2/logs/2026-09-04.log"],
    ["cli/log/zcode-2026-09-04.jsonl", "logs", "cli/log/zcode-2026-09-04.jsonl"],
    ["v2/crash/archive/x.dmp", "logs", "v2/crash/archive"],
    ["feedback/logs/a.zip", "logs", "feedback/logs/a.zip"],
    ["feedback/attachments/a.png", "exports", "feedback/attachments"],
    ["computer-use/run/helper.exit.log", "logs", "computer-use/run/helper.exit.log"],
    ["backup/session-projects-1/v2/x", "backups", "backup/session-projects-1"],
    ["cli/db/backup/db.pre-projects.1.sqlite", "backups", "cli/db/backup/db.pre-projects.1.sqlite"],
    ["cli/db/db.sqlite.bak-agent-control", "backups", "cli/db/db.sqlite.bak-agent-control"],
    [
      "cli/db/db.sqlite.backup-before-drop-shm",
      "backups",
      "cli/db/db.sqlite.backup-before-drop-shm",
    ],
    ["v2/migrations/x/journal.json", "backups", "v2/migrations/x"],
    ["v2/model-providers.json.bak", "backups", "v2/model-providers.json.bak"],
    ["v2/model-providers.v1.backup.json", "backups", "v2/model-providers.v1.backup.json"],
    ["v2/setting.json.corrupt-2026", "backups", "v2/setting.json.corrupt-2026"],
    ["v2/setting.json.codex-perf-backup-1", "backups", "v2/setting.json.codex-perf-backup-1"],
    ["v2/config.json.pre-provider-v1-abc.bak", "backups", "v2/config.json.pre-provider-v1-abc.bak"],
    ["cli/config.json.bak-2026", "backups", "cli/config.json.bak-2026"],
    ["export-log/zcode-logs-1/a.zip", "exports", "export-log/zcode-logs-1"],
    ["export-log-stage/stage-x/a", "exports", "export-log-stage/stage-x"],
    ["cli/exec/sess_1/out.txt", "toolOutputs", "cli/exec/sess_1"],
    ["cli/image-cache/sess_1/a.png", "toolOutputs", "cli/image-cache/sess_1"],
    ["cli/plugins/cache/m/x", "runtimes", "cli/plugins/cache"],
    ["cli/plugins/data/x", "runtimes", "cli/plugins/data"],
    ["v2/coding-plan-cache.json", "toolOutputs", "v2/coding-plan-cache.json"],
    ["v2/bots-model-cache.v2.json", "toolOutputs", "v2/bots-model-cache.v2.json"],
    ["tmp/paste-attachments/2026/a.txt", "toolOutputs", "tmp/paste-attachments"],
    ["agents/claude-code/bin/x", "runtimes", "agents/claude-code"],
    ["agents/code-reviewer.md", "config", "agents/code-reviewer.md"],
    ["lite/releases/3.6.0/x", "runtimes", "lite/releases"],
    ["computer-use/dev/App.app/Contents/x", "runtimes", "computer-use/dev"],
    ["bundled-agents/opencode.tgz", "runtimes", "bundled-agents/opencode.tgz"],
    ["v2/setting.json", "config", "v2/setting.json"],
    ["v2/credentials.json", "config", "v2/credentials.json"],
    ["v2/acp-config/codex/x", "config", "v2/acp-config/codex"],
    ["cli/config.json", "config", "cli/config.json"],
    ["cli/memories/projects/x.md", "config", "cli/memories/projects"],
    ["security/workspace-hook-trust-v1.json", "config", "security/workspace-hook-trust-v1.json"],
    ["workspace/default/a.html", "config", "workspace/default"],
    ["AGENTS.md", "config", "AGENTS.md"],
    ["agent/sessions/x.json", "other", "agent"],
    [".DS_Store", "other", ".DS_Store"],
    ["unknown-dir/deep/file", "other", "unknown-dir"],
  ])("%s → %s (%s)", (path, categoryId, entryKey) => {
    expect(classifyStoragePath(path, home)).toEqual({ categoryId, entryKey });
  });

  it("treats the stale home v2 copy as other only when a custom data dir is active", () => {
    const custom: StorageCatalogContext = { rootId: "home", hasCustomDataBaseDir: true };
    expect(classifyStoragePath("v2/logs/a.log", custom)).toEqual({
      categoryId: "other",
      entryKey: "v2",
    });
    expect(classifyStoragePath("v2/tasks-index.sqlite", custom).categoryId).toBe("other");
    expect(classifyStoragePath("cli/debug/x.jsonl", custom).categoryId).toBe("modelTrajectory");
    const dataBaseDir: StorageCatalogContext = {
      rootId: "dataBaseDir",
      hasCustomDataBaseDir: true,
    };
    expect(classifyStoragePath("v2/logs/a.log", dataBaseDir).categoryId).toBe("logs");
  });

  it("normalizes windows separators and surrounding slashes", () => {
    expect(classifyStoragePath("\\cli\\debug\\x.jsonl", home).categoryId).toBe("modelTrajectory");
    expect(classifyStoragePath("/v2/logs/x.log/", home).entryKey).toBe("v2/logs/x.log");
  });
});

describe("cleanability, protection and clean scopes", () => {
  it("declares every category and only allows cleaning of cleanable ones", () => {
    for (const id of STORAGE_CATEGORY_IDS) {
      expect(["none", "safe", "confirm"]).toContain(getStorageCategoryCleanability(id));
    }
    expect(getStorageCategoryCleanability("modelTrajectory")).toBe("safe");
    expect(getStorageCategoryCleanability("backups")).toBe("confirm");
    expect(getStorageCategoryCleanability("sessionStore")).toBe("none");
    expect(getStorageCategoryCleanability("toolOutputs")).toBe("none");
    expect(getStorageCategoryCleanability("subagentTranscripts")).toBe("safe");
    expect(getStorageCleanScopes("subagentTranscripts")).toEqual([
      { prefix: "cli/agents", recursive: true },
    ]);
    expect(getStorageCleanScopes("toolOutputs")).toEqual([]);
    expect(getStorageCleanScopes("sessionStore")).toEqual([]);
    expect(getStorageCleanScopes("other")).toEqual([]);
  });

  it("protects bootstrap, credential, broker token, diagnostics toggle and live crash files", () => {
    for (const path of [
      "v2/setting.json",
      "v2/setting.json.lock",
      "v2/credentials.json",
      "computer-use/run/.tokens",
      "v2/dev/zcode-stdio-tap.json",
      "v2/crash/live/current.dmp",
    ]) {
      expect(isProtectedStoragePath(path), path).toBe(true);
    }
    for (const path of ["v2/setting.json.corrupt-1", "v2/logs/a.log", "v2/crash/archive/x"]) {
      expect(isProtectedStoragePath(path), path).toBe(false);
    }
  });

  it("lists recursive prefix scopes plus shallow directories for file rules", () => {
    expect(getStorageCleanScopes("backups")).toEqual([
      { prefix: "backup", recursive: true },
      { prefix: "v2/backup", recursive: true },
      { prefix: "v2/migrations", recursive: true },
      { prefix: "cli/db/backup", recursive: true },
      { prefix: "cli/db/backups", recursive: true },
      { prefix: "cli/db", recursive: false },
      { prefix: "cli", recursive: false },
      { prefix: "v2", recursive: false },
    ]);
    expect(getStorageCleanScopes("modelTrajectory")).toEqual([
      { prefix: "cli/debug", recursive: true },
      { prefix: "cli/rollout", recursive: true },
    ]);
  });
});
