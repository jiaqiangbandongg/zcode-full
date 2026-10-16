# SSH Remote Skill Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let desktop users sync selected local user skills into a connected SSH remote host's `~/.zcode/skills`, with missing skills selectable by default and existing remote skills skipped.

**Architecture:** Add a narrow `skill-sync` RPC service registered on local and remote service collections. The UI opens one reusable dialog from SSH workspace header, `Settings > Skills`, and the connected SSH directory step; the dialog uses base services for local export and the current remote workspace services for remote status/import.

**Tech Stack:** TypeScript, React, Zustand service context, `@zcode/rpc` ProxyChannel services, Node `fs/promises`, Node `zlib`, Vitest, existing shadcn/radix UI primitives.

---

## File Structure

- `packages/shared/src/channels.ts`: add the `SkillSync` service channel.
- `packages/shared/src/skill-sync.ts`: shared DTOs for candidates, remote statuses, archives, and import results.
- `packages/shared/src/index.ts`: export skill sync DTOs.
- `packages/services/src/skill-sync/skillSync.ts`: `ISkillSyncService` descriptor and interface.
- `packages/services/src/skill-sync/skillSyncArchive.ts`: sync-specific `.tar.gz` archive writer/reader with strict path safety.
- `packages/services/src/skill-sync/skillSyncService.ts`: local/remote implementation for listing user skills, exporting archives, checking remote status, and importing into `~/.zcode/skills`.
- `packages/services/src/accessor.ts`, `packages/services/src/index.ts`, `packages/services/src/node.ts`: expose/register the new service.
- `packages/client/src/remoteServiceAccess.ts`: proxy the new service over RPC.
- `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`: register remote workspace `skillSyncService`.
- `packages/ui/src/settings/RemoteSkillSyncDialog.tsx`: reusable dialog.
- `packages/ui/src/settings/SkillsSection.tsx`, `packages/ui/src/SettingsPage.tsx`: context-aware Settings entry.
- `packages/ui/src/WorkspaceHeaderSections.tsx`: SSH workspace header entry.
- `packages/ui/src/RemoteConnectionDialogContent.tsx`, `packages/ui/src/SSHDialog.tsx`: connected SSH directory-step entry.
- `packages/ui/src/i18n/locales/en-US.ts`, `packages/ui/src/i18n/locales/zh-CN.ts`: localized labels.
- Tests:
  - `packages/services/test/skillSyncArchive.test.ts`
  - `packages/services/test/skillSyncService.test.ts`
  - `packages/ui/test/remoteSkillSyncDialog.test.tsx`
  - `packages/ui/test/skillsSection.test.ts`
  - `packages/ui/test/remoteSkillSyncEntryVisibility.test.ts`

---

### Task 1: Shared Contract And RPC Wiring

**Files:**
- Modify: `packages/shared/src/channels.ts`
- Create: `packages/shared/src/skill-sync.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/services/src/skill-sync/skillSync.ts`
- Modify: `packages/services/src/accessor.ts`
- Modify: `packages/services/src/index.ts`
- Modify: `packages/client/src/remoteServiceAccess.ts`

- [ ] **Step 1: Add shared channel and DTOs**

In `packages/shared/src/channels.ts`, add the channel next to `Skills`:

```ts
  /** SSH 远程 skills 同步服务 */
  SkillSync: "skill-sync",
```

Create `packages/shared/src/skill-sync.ts`:

```ts
export type SkillSyncImportStatus = "synced" | "skipped" | "failed";

export interface SkillSyncCandidate {
  id: string;
  name: string;
  directoryName: string;
  description: string;
  path: string;
  sizeBytes: number;
}

export interface SkillSyncCandidateListResult {
  candidates: SkillSyncCandidate[];
  maxArchiveBytes: number;
}

export interface SkillSyncRemoteStatus {
  directoryName: string;
  exists: boolean;
  path?: string;
}

export interface SkillSyncRemoteStatusResult {
  statuses: SkillSyncRemoteStatus[];
}

export interface SkillSyncArchiveExportResult {
  archive: Uint8Array;
  archiveBytes: number;
  skills: Array<{
    id: string;
    name: string;
    directoryName: string;
  }>;
}

export interface SkillSyncImportResultItem {
  name: string;
  directoryName: string;
  status: SkillSyncImportStatus;
  path?: string;
  error?: string;
}

export interface SkillSyncImportResult {
  results: SkillSyncImportResultItem[];
}
```

In `packages/shared/src/index.ts`, export the file:

```ts
export * from "./skill-sync.js";
```

- [ ] **Step 2: Add service descriptor**

Create `packages/services/src/skill-sync/skillSync.ts`:

```ts
import type {
  SkillSyncArchiveExportResult,
  SkillSyncCandidateListResult,
  SkillSyncImportResult,
  SkillSyncRemoteStatusResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISkillSyncService {
  listLocalUserSkillCandidates(): Promise<SkillSyncCandidateListResult>;
  listRemoteUserSkillStatuses(params: {
    directoryNames: string[];
  }): Promise<SkillSyncRemoteStatusResult>;
  exportSkillsArchive(params: {
    skillIds: string[];
  }): Promise<SkillSyncArchiveExportResult>;
  importSkillsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<SkillSyncImportResult>;
}

export const ISkillSyncService =
  createServiceDescriptor<ISkillSyncService>(ServiceChannels.SkillSync);
```

- [ ] **Step 3: Wire service into public accessors**

In `packages/services/src/accessor.ts`, add:

```ts
import type { ISkillSyncService } from "./skill-sync/skillSync.js";
```

and in `IServiceAccessor`:

```ts
  readonly skillSyncService: ISkillSyncService;
```

In `packages/services/src/index.ts`, add:

```ts
export { ISkillSyncService } from "./skill-sync/skillSync.js";
```

In `packages/client/src/remoteServiceAccess.ts`, import `ISkillSyncService`, add the readonly field:

```ts
  readonly skillSyncService: ISkillSyncService;
```

and initialize it after `skillsService`:

```ts
    this.skillSyncService = ProxyChannel.toService<ISkillSyncService>(
      channelClient.getChannel(ISkillSyncService.channelName),
    );
```

- [ ] **Step 4: Run typecheck to capture missing registrations**

Run:

```bash
pnpm typecheck
```

Expected: fail with missing `skillSyncService` on service collections and mocks. Keep the failure output for Task 3 and Task 4 wiring.

- [ ] **Step 5: Commit contract skeleton**

```bash
git add packages/shared/src/channels.ts packages/shared/src/skill-sync.ts packages/shared/src/index.ts packages/services/src/skill-sync/skillSync.ts packages/services/src/accessor.ts packages/services/src/index.ts packages/client/src/remoteServiceAccess.ts
git commit -m "feat: add skill sync service contract"
```

---

### Task 2: Safe Skill Archive Helper

**Files:**
- Create: `packages/services/src/skill-sync/skillSyncArchive.ts`
- Test: `packages/services/test/skillSyncArchive.test.ts`

- [ ] **Step 1: Write failing archive safety tests**

Create `packages/services/test/skillSyncArchive.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSkillSyncArchive,
  extractSkillSyncArchive,
} from "../src/skill-sync/skillSyncArchive.js";

async function tempDir() {
  return await mkdtemp(join(tmpdir(), "zcode-skill-sync-"));
}

describe("skill sync archive", () => {
  it("round-trips regular skill directories", async () => {
    const root = await tempDir();
    const skillDir = join(root, "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: review\n---\nbody");
    await writeFile(join(skillDir, "notes.txt"), "hello");

    const archive = await createSkillSyncArchive([
      { sourcePath: skillDir, archivePath: "review" },
    ]);
    const output = join(root, "out");
    await extractSkillSyncArchive(archive, output);

    await expect(readFile(join(output, "review", "SKILL.md"), "utf-8")).resolves.toContain(
      "name: review",
    );
    await expect(readdir(join(output, "review"))).resolves.toContain("notes.txt");
  });

  it("rejects path traversal entries", async () => {
    const root = await tempDir();
    const skillDir = join(root, "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: review\n---\nbody");

    await expect(
      createSkillSyncArchive([{ sourcePath: skillDir, archivePath: "../review" }]),
    ).rejects.toThrow("unsafe skill archive path");
  });
});
```

- [ ] **Step 2: Run archive tests and verify failure**

Run:

```bash
pnpm vitest run packages/services/test/skillSyncArchive.test.ts
```

Expected: fail because `skillSyncArchive.ts` does not exist.

- [ ] **Step 3: Implement minimal safe archive helper**

Create `packages/services/src/skill-sync/skillSyncArchive.ts` using Node built-ins. Use this shape:

```ts
import { gzip, gunzip } from "node:zlib";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const TAR_BLOCK_SIZE = 512;
const TAR_END_BLOCK_BYTES = TAR_BLOCK_SIZE * 2;

export interface SkillSyncArchiveEntry {
  sourcePath: string;
  archivePath: string;
}

export async function createSkillSyncArchive(
  entries: readonly SkillSyncArchiveEntry[],
): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    await appendTarEntry(parts, entry.sourcePath, normalizeArchivePath(entry.archivePath));
  }
  parts.push(Buffer.alloc(TAR_END_BLOCK_BYTES));
  return await gzipAsync(Buffer.concat(parts));
}

export async function extractSkillSyncArchive(
  archive: Uint8Array,
  targetDir: string,
): Promise<void> {
  const targetRoot = resolve(targetDir);
  await mkdir(targetRoot, { recursive: true });
  const buffer = await gunzipAsync(Buffer.from(archive));
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) break;
    const size = readTarOctal(header, 124, 12);
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    const typeFlag = readTarString(header, 156, 1) || "0";
    const archivePath = normalizeArchivePath(readTarEntryPath(header));
    const targetPath = resolveWithin(targetRoot, archivePath);
    if (typeFlag === "5") {
      await mkdir(targetPath, { recursive: true });
    } else if (typeFlag === "0" || typeFlag === "\0") {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, data);
    } else {
      throw new Error(`unsupported skill archive entry type: ${typeFlag}`);
    }
  }
}
```

Add these helper functions in the same file: `appendTarEntry`, `createTarHeader`, `readTarEntryPath`, `readTarString`, `readTarOctal`, `writeTarString`, `writeTarOctal`, `writeTarChecksum`, `normalizeArchivePath`, `resolveWithin`. `appendTarEntry` must recursively sort directory children by name, write directory entries with tar type `"5"`, write regular files with type `"0"`, and reject symlinks and special files with this guard:

```ts
if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
  throw new Error(`unsupported skill archive source: ${sourcePath}`);
}
```

`normalizeArchivePath` must throw for absolute paths, backslashes, empty paths, and `..` segments:

```ts
function normalizeArchivePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !normalized ||
    isAbsolute(path) ||
    path.includes("\\") ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`unsafe skill archive path: ${path}`);
  }
  return normalized;
}
```

- [ ] **Step 4: Run archive tests**

Run:

```bash
pnpm vitest run packages/services/test/skillSyncArchive.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit archive helper**

```bash
git add packages/services/src/skill-sync/skillSyncArchive.ts packages/services/test/skillSyncArchive.test.ts
git commit -m "feat: add safe skill sync archive helper"
```

---

### Task 3: Skill Sync Service Implementation

**Files:**
- Create: `packages/services/src/skill-sync/skillSyncService.ts`
- Modify: `packages/services/src/node.ts`
- Modify: `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`
- Test: `packages/services/test/skillSyncService.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `packages/services/test/skillSyncService.test.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createSkillSyncService } from "../src/skill-sync/skillSyncService.js";

function makeHome() {
  return mkdtempSync(join(tmpdir(), "zcode-skill-sync-home-"));
}

async function writeSkill(home: string, directoryName: string, name = directoryName) {
  const dir = join(home, ".zcode", "skills", directoryName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} desc\n---\nBody`);
  return dir;
}

describe("skill sync service", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  it("lists only local user zcode skills as candidates", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeSkill(home, "review");
    const service = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const result = await service.listLocalUserSkillCandidates();

    expect(result.candidates).toMatchObject([
      {
        name: "review",
        directoryName: "review",
        description: "review desc",
      },
    ]);
    process.env.HOME = originalHome;
  });

  it("imports missing skills and skips existing directory names", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeSkill(localHome, "review");
    const localService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });
    const candidates = await localService.listLocalUserSkillCandidates();
    const archive = await localService.exportSkillsArchive({
      skillIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeSkill(remoteHome, "existing");
    const remoteService = createSkillSyncService({ maxArchiveBytes: 1024 * 1024 });

    const first = await remoteService.importSkillsArchive({ archive: archive.archive });
    const second = await remoteService.importSkillsArchive({ archive: archive.archive });

    expect(first.results[0]).toMatchObject({ directoryName: "review", status: "synced" });
    expect(second.results[0]).toMatchObject({ directoryName: "review", status: "skipped" });
    await expect(readFile(join(remoteHome, ".zcode", "skills", "review", "SKILL.md"), "utf-8"))
      .resolves.toContain("name: review");
    process.env.HOME = originalHome;
  });
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run:

```bash
pnpm vitest run packages/services/test/skillSyncService.test.ts
```

Expected: fail because `skillSyncService.ts` does not exist.

- [ ] **Step 3: Implement service**

Create `packages/services/src/skill-sync/skillSyncService.ts` with these exported shapes:

```ts
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  SkillSyncArchiveExportResult,
  SkillSyncCandidate,
  SkillSyncCandidateListResult,
  SkillSyncImportResult,
  SkillSyncRemoteStatusResult,
} from "@zcode/shared";
import type { ISkillSyncService } from "./skillSync.js";
import {
  createSkillSyncArchive,
  extractSkillSyncArchive,
} from "./skillSyncArchive.js";

const SKILL_FILE_NAME = "SKILL.md";
const DEFAULT_MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;

export function createSkillSyncService(options?: {
  maxArchiveBytes?: number;
}): ISkillSyncService {
  const maxArchiveBytes = options?.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  return {
    async listLocalUserSkillCandidates() {
      return {
        candidates: await collectUserSkillCandidates(),
        maxArchiveBytes,
      };
    },
    async listRemoteUserSkillStatuses(params) {
      const root = getUserZcodeSkillRoot();
      return {
        statuses: params.directoryNames.map((directoryName) => {
          const path = join(root, directoryName);
          return existsSync(join(path, SKILL_FILE_NAME))
            ? { directoryName, exists: true, path }
            : { directoryName, exists: false };
        }),
      };
    },
    async exportSkillsArchive(params) {
      const candidates = await collectUserSkillCandidates();
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const selected = params.skillIds.map((id) => {
        const candidate = candidateById.get(id);
        if (!candidate) throw new Error(`skill sync candidate not found: ${id}`);
        return candidate;
      });
      const archive = await createSkillSyncArchive(
        selected.map((candidate) => ({
          sourcePath: dirnameFromSkillPath(candidate.path),
          archivePath: candidate.directoryName,
        })),
      );
      if (archive.byteLength > maxArchiveBytes) {
        throw new Error(`skill sync archive exceeds limit: ${archive.byteLength}/${maxArchiveBytes}`);
      }
      return {
        archive,
        archiveBytes: archive.byteLength,
        skills: selected.map(({ id, name, directoryName }) => ({ id, name, directoryName })),
      } satisfies SkillSyncArchiveExportResult;
    },
    async importSkillsArchive(params) {
      if (params.overwrite) throw new Error("skill sync overwrite is not supported");
      if (params.archive.byteLength > maxArchiveBytes) {
        throw new Error(`skill sync archive exceeds limit: ${params.archive.byteLength}/${maxArchiveBytes}`);
      }
      return await importArchive(params.archive);
    },
  };
}
```

Add these helper functions in the same file with the listed behavior:

- `resolveUserHomeDir()` uses `HOME`, `USERPROFILE`, then `homedir()`.
- `getUserZcodeSkillRoot()` returns `join(resolveUserHomeDir(), ".zcode", "skills")`.
- `collectUserSkillCandidates()` scans immediate child directories under `~/.zcode/skills`, requires `SKILL.md`, parses frontmatter `name` and `description`, computes `id` as sha256 of the absolute skill directory path, and computes recursive size.
- `importArchive()` extracts to a temp dir under `~/.zcode/skills/.sync-tmp-<uuid>`, verifies each child contains `SKILL.md`, copies each missing child to `~/.zcode/skills/<directoryName>`, skips existing children, and removes the temp dir in `finally`.

Add the Chinese bugfix/security comment at the extraction boundary:

```ts
// 修复原因：远端同步接收的是本机传来的归档，必须先解到临时目录并校验 SKILL.md，
// 再逐个复制到用户级 skills 根，避免路径穿越或半成品目录污染远端配置。
```

- [ ] **Step 4: Register service in local and remote collections**

In `packages/services/src/node.ts`, export and import `createSkillSyncService` and `ISkillSyncService`, then register after `ISkillsService`:

```ts
.register(ISkillSyncService, createSkillSyncService())
```

In `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`, import both and register:

```ts
.register(ISkillSyncService, params.connectionServices.skillSyncService)
```

Keep `skillSyncService` from `connectionServices` in remote workspace service collections; it must read/write the remote filesystem.

- [ ] **Step 5: Run service tests and typecheck**

Run:

```bash
pnpm vitest run packages/services/test/skillSyncArchive.test.ts packages/services/test/skillSyncService.test.ts
pnpm typecheck
```

Expected: tests pass. Typecheck fails only for known UI mocks until Task 4 and Task 5 add `skillSyncService` to those mocks.

- [ ] **Step 6: Commit service implementation**

```bash
git add packages/services/src/skill-sync packages/services/test/skillSyncService.test.ts packages/services/src/node.ts packages/desktop/src/host/remoteWorkspaceServiceCollection.ts
git commit -m "feat: implement skill sync service"
```

---

### Task 4: Reusable Remote Skill Sync Dialog

**Files:**
- Create: `packages/ui/src/settings/RemoteSkillSyncDialog.tsx`
- Test: `packages/ui/test/remoteSkillSyncDialog.test.tsx`
- Modify: `packages/ui/test/skillsSection.test.ts` service mock objects so they include `skillSyncService`

- [ ] **Step 1: Write failing dialog test**

Create `packages/ui/test/remoteSkillSyncDialog.test.tsx`:

```tsx
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RemoteSkillSyncDialog } from "../src/settings/RemoteSkillSyncDialog.js";

describe("RemoteSkillSyncDialog", () => {
  it("renders SSH target and selectable local skills", async () => {
    const localSkillSyncService = {
      listLocalUserSkillCandidates: vi.fn(async () => ({
        maxArchiveBytes: 1024 * 1024,
        candidates: [
          {
            id: "skill-1",
            name: "review",
            directoryName: "review",
            description: "Review code",
            path: "/Users/me/.zcode/skills/review/SKILL.md",
            sizeBytes: 128,
          },
        ],
      })),
      exportSkillsArchive: vi.fn(),
    };
    const remoteSkillSyncService = {
      listRemoteUserSkillStatuses: vi.fn(async () => ({
        statuses: [{ directoryName: "review", exists: false }],
      })),
      importSkillsArchive: vi.fn(),
    };

    const html = renderToStaticMarkup(
      <RemoteSkillSyncDialog
        open
        onOpenChange={() => undefined}
        localSkillSyncService={localSkillSyncService as never}
        remoteSkillSyncService={remoteSkillSyncService as never}
        remoteTarget={{ kind: "ssh", host: "dev.example.com", username: "alice", port: 22 }}
        workspacePath="/home/alice/project"
        workspaceIdentity="ssh://alice@dev.example.com/home/alice/project"
        onSynced={async () => undefined}
      />,
    );

    expect(html).toContain("dev.example.com");
    expect(html).toContain("review");
  });
});
```

- [ ] **Step 2: Run dialog test and verify failure**

Run:

```bash
pnpm vitest run packages/ui/test/remoteSkillSyncDialog.test.tsx
```

Expected: fail because component does not exist.

- [ ] **Step 3: Implement dialog component**

Create `packages/ui/src/settings/RemoteSkillSyncDialog.tsx`. The public props must be:

```tsx
import type { RemoteTarget, SkillSyncCandidate, SkillSyncRemoteStatus } from "@zcode/shared";
import type { ISkillSyncService } from "@zcode/services";

interface RemoteSkillSyncDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  localSkillSyncService: ISkillSyncService;
  remoteSkillSyncService: ISkillSyncService;
  remoteTarget: RemoteTarget;
  workspacePath: string;
  workspaceIdentity?: string;
  onSynced: () => Promise<void> | void;
}
```

Use existing compact primitives:

- `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`
- `Button`
- Native `<input type="checkbox">` with fixed `size-4` dimensions and accessible labels
- `ControlHintTooltip` only for icon-only controls

State machine:

```ts
type Step = "loading" | "selection" | "syncing" | "complete";
```

Load flow in `useEffect` when `open`:

```ts
const [candidatesResult, remoteStatuses] = await Promise.all([
  localSkillSyncService.listLocalUserSkillCandidates(),
  remoteSkillSyncService.listRemoteUserSkillStatuses({
    directoryNames: candidates.map((candidate) => candidate.directoryName),
  }),
]);
```

Implementation detail: because remote statuses need candidate directory names, load candidates first, then statuses:

```ts
const localResult = await localSkillSyncService.listLocalUserSkillCandidates();
const remoteResult = await remoteSkillSyncService.listRemoteUserSkillStatuses({
  directoryNames: localResult.candidates.map((candidate) => candidate.directoryName),
});
```

Default selection includes only candidates where `exists === false`.

Sync action:

```ts
const archive = await localSkillSyncService.exportSkillsArchive({
  skillIds: selectedIds,
});
const result = await remoteSkillSyncService.importSkillsArchive({
  archive: archive.archive,
  overwrite: false,
});
await onSynced();
setImportResult(result);
setStep("complete");
```

Add a small pure helper in the same file for tests and clarity:

```ts
export function buildRemoteSkillSyncRows(
  candidates: readonly SkillSyncCandidate[],
  statuses: readonly SkillSyncRemoteStatus[],
) {
  const statusByDirectory = new Map(statuses.map((status) => [status.directoryName, status]));
  return candidates.map((candidate) => ({
    candidate,
    exists: statusByDirectory.get(candidate.directoryName)?.exists ?? false,
  }));
}
```

- [ ] **Step 4: Add i18n keys used by dialog**

Add English and Chinese keys:

```ts
"settings.skills.remoteSync.open": "Sync local Skills to this SSH host",
"settings.skills.remoteSync.title": "Sync Skills to SSH host",
"settings.skills.remoteSync.target": "Target: {target}",
"settings.skills.remoteSync.empty": "No local user skills found.",
"settings.skills.remoteSync.selectAll": "Select all missing",
"settings.skills.remoteSync.clearAll": "Clear all",
"settings.skills.remoteSync.start": "Sync selected",
"settings.skills.remoteSync.syncing": "Syncing skills...",
"settings.skills.remoteSync.existing": "Already exists on remote",
"settings.skills.remoteSync.synced": "Synced",
"settings.skills.remoteSync.skipped": "Skipped",
"settings.skills.remoteSync.failed": "Failed",
"settings.skills.remoteSync.complete": "Skill sync complete.",
```

Use corresponding Chinese translations in `zh-CN.ts`.

- [ ] **Step 5: Run dialog test**

Run:

```bash
pnpm vitest run packages/ui/test/remoteSkillSyncDialog.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit dialog**

```bash
git add packages/ui/src/settings/RemoteSkillSyncDialog.tsx packages/ui/test/remoteSkillSyncDialog.test.tsx packages/ui/src/i18n/locales/en-US.ts packages/ui/src/i18n/locales/zh-CN.ts
git commit -m "feat: add remote skill sync dialog"
```

---

### Task 5: Settings Skills Context Entry

**Files:**
- Modify: `packages/ui/src/SettingsPage.tsx`
- Modify: `packages/ui/src/settings/SkillsSection.tsx`
- Test: `packages/ui/test/skillsSection.test.ts`

- [ ] **Step 1: Update SkillsSection props and tests first**

In `packages/ui/test/skillsSection.test.ts`, add test coverage for a connected SSH context:

```ts
it("shows remote sync entry for connected SSH workspace", async () => {
  activeWorkspacePath = "/home/alice/project";
  activeWorkspaceIdentity = "ssh://alice@dev.example.com/home/alice/project";
  activeRemoteSessionId = "remote-session-1";
  activeRemoteTarget = { kind: "ssh", host: "dev.example.com", username: "alice", port: 22 };

  const html = await renderSkillsSection();

  expect(html).toContain("dev.example.com");
  expect(html).toContain("Sync local Skills to this SSH host");
});
```

Adjust the local render helper to pass props:

```ts
return renderToStaticMarkup(
  createElement(SkillsSection, {
    workspacePath: activeWorkspacePath,
    workspaceIdentity: activeWorkspaceIdentity,
    remoteSessionId: activeRemoteSessionId,
    remoteTarget: activeRemoteTarget,
  }),
);
```

- [ ] **Step 2: Run skills section test and verify failure**

Run:

```bash
pnpm vitest run packages/ui/test/skillsSection.test.ts
```

Expected: fail because props and UI entry are not implemented.

- [ ] **Step 3: Make SkillsSection explicit-context**

Change `SkillsSection` signature:

```tsx
interface SkillsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
}

export function SkillsSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
}: SkillsSectionProps) {
```

Remove internal `useTabStore` reads for active workspace path/identity. Replace usages:

```ts
const activeWorkspacePath = workspacePath ?? null;
const activeWorkspaceIdentity = workspaceIdentity;
```

Keep `activateTabByPath` from `useTabStore`.

Compute connected SSH:

```ts
const isConnectedSshWorkspace = Boolean(
  remoteSessionId && remoteTarget?.kind === "ssh" && activeWorkspacePath,
);
```

Get local base services and remote/current services:

```ts
const baseServices = useBaseWorkspaceServices();
const { skillSyncService: remoteSkillSyncService } = useServices();
```

Add `RemoteSkillSyncDialog` state and render it when `isConnectedSshWorkspace`.

Add a compact context line near the top:

```tsx
{isConnectedSshWorkspace ? (
  <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground-subtle">
    {intl.formatMessage(
      { id: "settings.skills.remoteContext" },
      { target: `${remoteTarget.username}@${remoteTarget.host}`, path: activeWorkspacePath },
    )}
  </div>
) : null}
```

Add the sync button in the existing header action group, using an icon from `lucide-react` such as `UploadCloud`.

- [ ] **Step 4: Pass explicit props from SettingsPage**

In `packages/ui/src/SettingsPage.tsx`, compute active workspace tab near existing active workspace values:

```ts
const activeWorkspaceTab = useTabStore((state) => {
  const activeTab = state.activeTabId
    ? state.tabs.find((tab) => tab.id === state.activeTabId)
    : null;
  return activeTab?.kind === "workspace" ? activeTab : null;
});
```

Pass props:

```tsx
<SkillsSection
  workspacePath={activeWorkspacePath}
  workspaceIdentity={activeWorkspaceIdentity}
  remoteSessionId={activeWorkspaceTab?.remoteSessionId}
  remoteTarget={activeWorkspaceTab?.remoteTarget}
/>
```

- [ ] **Step 5: Run skills tests**

Run:

```bash
pnpm vitest run packages/ui/test/skillsSection.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit Settings entry**

```bash
git add packages/ui/src/SettingsPage.tsx packages/ui/src/settings/SkillsSection.tsx packages/ui/test/skillsSection.test.ts
git commit -m "feat: add settings entry for remote skill sync"
```

---

### Task 6: SSH Workspace Header And SSH Dialog Entries

**Files:**
- Modify: `packages/ui/src/WorkspaceHeaderSections.tsx`
- Modify: `packages/ui/src/RemoteConnectionDialogContent.tsx`
- Modify: `packages/ui/src/SSHDialog.tsx`
- Test: `packages/ui/test/remoteSkillSyncEntryVisibility.test.ts`

- [ ] **Step 1: Add header entry helper test**

Create `packages/ui/test/remoteSkillSyncEntryVisibility.test.ts` and test a pure helper exported from `WorkspaceHeaderSections.tsx`:

```ts
export function shouldShowRemoteSkillSyncAction(params: {
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
}): boolean {
  return Boolean(params.remoteSessionId?.trim() && params.remoteTarget?.kind === "ssh");
}
```

Test:

```ts
expect(
  shouldShowRemoteSkillSyncAction({
    remoteSessionId: "session-1",
    remoteTarget: { kind: "ssh", host: "dev.example.com", username: "alice", port: 22 },
  }),
).toBe(true);
expect(
  shouldShowRemoteSkillSyncAction({
    remoteSessionId: "session-1",
    remoteTarget: { kind: "docker", container: "app" },
  }),
).toBe(false);
```

- [ ] **Step 2: Add header menu action**

In `WorkspaceHeaderSections.tsx`, import `UploadCloud`, `RemoteSkillSyncDialog`, and `useBaseWorkspaceServices`. Add dialog state:

```ts
const [remoteSkillSyncOpen, setRemoteSkillSyncOpen] = useState(false);
const baseServices = useBaseWorkspaceServices();
const showRemoteSkillSyncAction = shouldShowRemoteSkillSyncAction({
  remoteSessionId,
  remoteTarget,
});
```

Inside `DropdownMenuContent`, before `TaskActionMenuContent`, add:

```tsx
{showRemoteSkillSyncAction && remoteTarget ? (
  <>
    <DropdownMenuItem onSelect={() => setRemoteSkillSyncOpen(true)}>
      <UploadCloud className="size-3.5" />
      {intl.formatMessage({ id: "settings.skills.remoteSync.open" })}
    </DropdownMenuItem>
    <DropdownMenuSeparator />
  </>
) : null}
```

Render dialog after the dropdown:

```tsx
{showRemoteSkillSyncAction && remoteTarget ? (
  <RemoteSkillSyncDialog
    open={remoteSkillSyncOpen}
    onOpenChange={setRemoteSkillSyncOpen}
    localSkillSyncService={baseServices.skillSyncService}
    remoteSkillSyncService={services.skillSyncService}
    remoteTarget={remoteTarget}
    workspacePath={workspaceAbsPath}
    workspaceIdentity={workspaceIdentity}
    onSynced={async () => {
      await services.skillsService.list({
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
      });
    }}
  />
) : null}
```

Use `invalidateDeferredDraftSessionForSkillChange` in `onSynced` with reason `"remote-skill-sync"` so the next draft context reload sees the synced skill list.

- [ ] **Step 3: Add SSH directory-step entry props**

In `RemoteConnectionDirectoryStep`, add props:

```ts
remoteTarget?: RemoteTarget | null;
localSkillSyncService?: ISkillSyncService;
remoteSkillSyncService?: ISkillSyncService | null;
onSkillsSynced?: () => Promise<void> | void;
```

Show a secondary button above the directory browser success state when `remoteTarget?.kind === "ssh"` and both services exist:

```tsx
<Button
  type="button"
  variant="secondary"
  size="sm"
  onClick={() => setRemoteSkillSyncOpen(true)}
>
  <UploadCloud className="size-3.5" />
  {intl.formatMessage({ id: "settings.skills.remoteSync.open" })}
</Button>
```

Mount `RemoteSkillSyncDialog` in this component with `workspacePath=""` because the directory has not been selected yet. Use target-only display in the dialog for empty path.

- [ ] **Step 4: Pass services from SSHDialog**

In `SSHDialog.tsx`, import `useBaseWorkspaceServices`. Add:

```ts
const baseServices = useBaseWorkspaceServices();
```

Pass into `RemoteConnectionDirectoryStep`:

```tsx
remoteTarget={pendingRemoteTarget}
localSkillSyncService={baseServices.skillSyncService}
remoteSkillSyncService={directoryBrowserServices?.skillSyncService ?? null}
onSkillsSynced={async () => undefined}
```

- [ ] **Step 5: Run targeted UI tests**

Run the relevant tests:

```bash
pnpm vitest run packages/ui/test/remoteSkillSyncDialog.test.tsx packages/ui/test/skillsSection.test.ts packages/ui/test/remoteSkillSyncEntryVisibility.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 6: Commit entry points**

```bash
git add packages/ui/src/WorkspaceHeaderSections.tsx packages/ui/src/RemoteConnectionDialogContent.tsx packages/ui/src/SSHDialog.tsx packages/ui/test
git commit -m "feat: expose remote skill sync entry points"
```

---

### Task 7: Final Verification And Cleanup

**Files:**
- Verify all touched files.
- Update docs only if implementation changes product behavior beyond the design spec.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run packages/services/test/skillSyncArchive.test.ts packages/services/test/skillSyncService.test.ts packages/ui/test/remoteSkillSyncDialog.test.tsx packages/ui/test/skillsSection.test.ts packages/ui/test/remoteSkillSyncEntryVisibility.test.ts
```

Expected: pass.

- [ ] **Step 2: Run required repository checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both pass.

- [ ] **Step 3: Manual SSH smoke check**

In desktop dev mode, connect to an SSH workspace and verify:

```text
1. Header more menu shows "同步本地 Skills 到此 SSH 主机".
2. Settings > Skills shows the SSH context line and "同步到远端" entry.
3. SSH directory selection step shows the sync entry after connection succeeds.
4. Dialog defaults to missing local user skills selected.
5. Sync creates remote ~/.zcode/skills/<directory>/SKILL.md.
6. Running sync again shows the same skill as skipped.
```

When no SSH server is available, record this limitation in the final response and rely on service tests plus UI tests.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: only intended implementation files are modified.

- [ ] **Step 5: Final commit**

When `git status --short` shows cleanup changes after verification, commit them:

```bash
git add .
git commit -m "test: verify remote skill sync"
```

When `git status --short` is empty, do not create an empty commit.
