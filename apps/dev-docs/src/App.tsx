/* eslint-disable max-lines -- 文档站首屏、结构表格和概念索引需要共享筛选与高亮状态，先集中在单入口组件维护。 */
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpenText,
  Boxes,
  Braces,
  Database,
  FileJson,
  Filter,
  GitCompareArrows,
  GitBranch,
  Hash,
  HardDrive,
  LinkIcon,
  ListFilter,
  Moon,
  Network,
  Pause,
  Play,
  Radio,
  Search,
  Sun,
  Terminal,
  Waypoints,
} from "lucide-react";
import {
  concepts,
  flows,
  protocolSurfaces,
  stdioTrafficFrames,
  stdioTrafficLogFields,
  structures,
  type Concept,
  type ConceptKind,
  type FieldDoc,
  type StdioTrafficDirection,
  type StdioTrafficFrame,
  type StdioTrafficKind,
  type StructureDoc,
} from "@/data/protocolDocs.js";

const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));
const CapabilityMapView = lazy(() => import("@/capability-map/CapabilityMapView.js"));
const FeatureBoundaryGraphView = lazy(
  () => import("@/feature-boundary-graph/FeatureBoundaryGraphView.js"),
);

const kindLabel: Record<ConceptKind, string> = {
  compat: "兼容字段",
  id: "ID",
  protocol: "协议",
  runtime: "运行态",
  state: "状态",
};

const kindClassName: Record<ConceptKind, string> = {
  compat: "bg-warning/12 text-foreground border-warning/35",
  id: "bg-brand/12 text-foreground border-brand/35",
  protocol: "bg-file-node text-file-node-foreground border-file-node-hover",
  runtime: "bg-command-node text-command-node-foreground border-command-node-hover",
  state: "bg-skill-node text-skill-node-foreground border-skill-node-hover",
};

type DocsView = "capabilities" | "boundary" | "protocol" | "stdio";
type DirectionFilter = StdioTrafficDirection | "all";
type TrafficSourceMode = "real" | "mock";
type RealTrafficStatus = "loading" | "ready" | "empty" | "missing" | "error";

function getInitialDocsView(): DocsView {
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "capabilities" || view === "boundary" || view === "protocol" || view === "stdio"
    ? view
    : "stdio";
}

interface StdioTrafficApiRecordEnvelope {
  index: number;
  record: StdioTrafficTapRecord;
}

interface StdioTrafficApiResponse {
  status: RealTrafficStatus;
  logDir: string;
  records: StdioTrafficApiRecordEnvelope[];
  error?: string;
  filePath?: string;
  updatedAt?: string;
  workspaceHash?: string;
}

interface StdioTrafficTapRecord {
  ts?: string;
  workspaceKey?: string;
  proxyPid?: number;
  pid?: number | null;
  direction?: StdioTrafficDirection;
  bytes?: number;
  raw?: string;
  message?: unknown;
  parseError?: string | null;
  id?: unknown;
  method?: unknown;
  sessionId?: unknown;
  inputId?: unknown;
}

interface RealTrafficState {
  status: RealTrafficStatus;
  logDir: string;
  records: StdioTrafficApiRecordEnvelope[];
  error?: string;
  filePath?: string;
  updatedAt?: string;
  workspaceHash?: string;
}

const directionLabel: Record<StdioTrafficDirection, string> = {
  "agent-stderr": "stderr",
  "agent-to-app": "agent -> app",
  "app-to-agent": "app -> agent",
};

const directionClassName: Record<StdioTrafficDirection, string> = {
  "agent-stderr": "border-command-node-hover bg-command-node text-command-node-foreground",
  "agent-to-app": "border-skill-node-hover bg-skill-node text-skill-node-foreground",
  "app-to-agent": "border-file-node-hover bg-file-node text-file-node-foreground",
};

function normalizeText(value: string) {
  return value.toLowerCase().trim();
}

function matchesStructure(structure: StructureDoc, query: string) {
  if (!query) return true;
  const haystack = [
    structure.title,
    structure.path,
    structure.purpose,
    structure.oldShape ?? "",
    structure.newShape,
    structure.migration,
    ...structure.fields.flatMap((field) => [
      field.name,
      field.type,
      field.meaning,
      field.owner,
      field.oldName ?? "",
      field.notes ?? "",
    ]),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function matchesConcept(concept: Concept, query: string) {
  if (!query) return true;
  return [
    concept.name,
    concept.summary,
    concept.lifecycle,
    concept.owner,
    concept.source,
    ...(concept.aliases ?? []),
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function trafficTimestampToMs(timestamp: string) {
  const [timePart = "00:00:00", millisecondPart = "0"] = timestamp.split(".");
  const [hours = 0, minutes = 0, seconds = 0] = timePart
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  const milliseconds = Number.parseInt(millisecondPart.padEnd(3, "0").slice(0, 3), 10) || 0;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function sortTrafficFramesByNewest(frames: StdioTrafficFrame[]) {
  return [...frames].sort(
    (first, second) =>
      trafficTimestampToMs(second.timestamp) - trafficTimestampToMs(first.timestamp),
  );
}

function formatTrafficTimestamp(date: Date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function formatIsoTrafficTimestamp(value: string | undefined) {
  if (!value) {
    return "--:--:--.---";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return formatTrafficTimestamp(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function readMessageId(value: unknown) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function getMessagePayload(message: unknown) {
  if (!isRecord(message) || !isRecord(message.params)) {
    return undefined;
  }
  return isRecord(message.params.payload) ? message.params.payload : undefined;
}

function getTrafficRecordKind(record: StdioTrafficTapRecord): StdioTrafficKind {
  if (record.direction === "agent-stderr") {
    return "stderr";
  }

  if (record.method) {
    return typeof record.id === "undefined" ? "notification" : "request";
  }

  if (typeof record.id !== "undefined") {
    return "response";
  }

  return "notification";
}

function getTrafficRecordSummary(record: StdioTrafficTapRecord, kind: StdioTrafficKind) {
  if (kind === "stderr") {
    return (record.raw ?? "stderr").slice(0, 160);
  }

  if (record.parseError) {
    return `parse error: ${record.parseError}`;
  }

  const payload = getMessagePayload(record.message);
  const payloadType = readString(payload?.type);
  if (payloadType) {
    return payloadType;
  }

  if (kind === "response") {
    if (isRecord(record.message) && isRecord(record.message.error)) {
      return readString(record.message.error.message) ?? "response error";
    }
    return "response result";
  }

  return readString(record.method) ?? (record.raw ?? "traffic record").slice(0, 160);
}

function formatRawLine(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return raw;
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return raw;
  }
}

function mapTapRecordToFrame(
  envelope: StdioTrafficApiRecordEnvelope,
  workspaceHash: string | undefined,
): StdioTrafficFrame | null {
  const record = envelope.record;
  if (!record.direction) {
    return null;
  }

  const kind = getTrafficRecordKind(record);
  return {
    id: `real-${workspaceHash ?? "workspace"}-${envelope.index}-${record.ts ?? ""}`,
    timestamp: formatIsoTrafficTimestamp(record.ts),
    direction: record.direction,
    kind,
    method: readString(record.method),
    messageId: readMessageId(record.id),
    sessionId: readString(record.sessionId),
    inputId: readString(record.inputId),
    summary: getTrafficRecordSummary(record, kind),
    bytes: typeof record.bytes === "number" ? record.bytes : (record.raw ?? "").length,
    raw: record.raw ?? JSON.stringify(record.message ?? record),
  };
}

function linkTrafficFrames(frames: StdioTrafficFrame[]) {
  const requestByMessageId = new Map<string, StdioTrafficFrame>();
  const responseByMessageId = new Map<string, StdioTrafficFrame>();

  for (const frame of frames) {
    if (!frame.messageId) {
      continue;
    }
    if (frame.kind === "request") {
      requestByMessageId.set(frame.messageId, frame);
    } else if (frame.kind === "response") {
      responseByMessageId.set(frame.messageId, frame);
    }
  }

  return frames.map((frame) => {
    if (!frame.messageId) {
      return frame;
    }
    const linkedFrame =
      frame.kind === "request"
        ? responseByMessageId.get(frame.messageId)
        : frame.kind === "response"
          ? requestByMessageId.get(frame.messageId)
          : undefined;
    return linkedFrame ? { ...frame, linkedId: linkedFrame.id } : frame;
  });
}

function mapRealTrafficFrames(realTraffic: RealTrafficState) {
  return linkTrafficFrames(
    realTraffic.records
      .map((envelope) => mapTapRecordToFrame(envelope, realTraffic.workspaceHash))
      .filter((frame): frame is StdioTrafficFrame => frame !== null),
  );
}

function createLiveStdioTrafficFrame(sequence: number, timestamp: string): StdioTrafficFrame {
  const inputId = `inp_live_${String(sequence % 100).padStart(2, "0")}`;
  const messageId = String(20 + sequence);
  const eventSeq = 20 + sequence;

  if (sequence % 7 === 4) {
    return {
      id: `live-stderr-${sequence}`,
      timestamp,
      direction: "agent-stderr",
      kind: "stderr",
      sessionId: "sess_6b6a",
      summary: "provider heartbeat",
      bytes: 96,
      raw: `[zcode-agent] provider heartbeat seq=${eventSeq} status=streaming`,
    };
  }

  if (sequence % 5 === 1) {
    return {
      id: `live-send-${sequence}`,
      timestamp,
      direction: "app-to-agent",
      kind: "request",
      method: "session/send",
      messageId,
      sessionId: "sess_6b6a",
      inputId,
      summary: "new user input",
      bytes: 586,
      raw: `{
  "id": ${messageId},
  "method": "session/send",
  "params": {
    "sessionId": "sess_6b6a",
    "inputId": "${inputId}",
    "content": "debug live stdio frame ${sequence}"
  }
}`,
    };
  }

  if (sequence % 5 === 2) {
    return {
      id: `live-ack-${sequence}`,
      timestamp,
      direction: "agent-to-app",
      kind: "response",
      messageId,
      sessionId: "sess_6b6a",
      inputId,
      summary: "session/send accepted",
      bytes: 104,
      latencyMs: 8,
      raw: `{
  "id": ${messageId},
  "result": {
    "accepted": true,
    "inputId": "${inputId}"
  }
}`,
    };
  }

  return {
    id: `live-event-${sequence}`,
    timestamp,
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId,
    summary: sequence % 3 === 0 ? "message.part.delta" : "turn.progress",
    bytes: 520 + (sequence % 6) * 24,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": ${eventSeq},
    "payload": {
      "type": "${sequence % 3 === 0 ? "message.part.delta" : "turn.progress"}",
      "inputId": "${inputId}"
    }
  }
}`,
  };
}

export function App() {
  const [activeView, setActiveView] = useState<DocsView>(getInitialDocsView);
  const [query, setQuery] = useState("");
  const [activeConceptId, setActiveConceptId] = useState("inputId");
  const [isDark, setIsDark] = useState(false);
  const normalizedQuery = normalizeText(query);
  const activeConcept = conceptById.get(activeConceptId) ?? concepts[0];

  const filteredStructures = useMemo(
    () => structures.filter((structure) => matchesStructure(structure, normalizedQuery)),
    [normalizedQuery],
  );

  const filteredConcepts = useMemo(
    () => concepts.filter((concept) => matchesConcept(concept, normalizedQuery)),
    [normalizedQuery],
  );

  const selectView = useCallback((view: DocsView) => {
    setActiveView(view);
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    window.history.replaceState(null, "", url);
  }, []);

  const viewDescription =
    activeView === "capabilities"
      ? "产品能力群、维护边界与跨域语义关系"
      : activeView === "boundary"
        ? "feature-boundary-planner YAML 的节点、关系与边界"
        : activeView === "protocol"
          ? "trace / input / session 数据结构迁移与协议字段说明"
          : "Agent stdio 实时抓包与协议帧检查";

  return (
    <div className={isDark ? "dark min-h-dvh" : "min-h-dvh"}>
      <div className="min-h-dvh bg-background text-foreground">
        <header className="sticky top-0 z-20 border-b border-border bg-header/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-card-border bg-card">
                <Network className="size-4 text-brand" />
              </div>
              <div className="min-w-0">
                <h1 className="text-ui-lg font-medium">ZCode Developer Docs</h1>
                <p className="text-ui-sm text-foreground-subtle">{viewDescription}</p>
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center">
              <nav className="grid grid-cols-4 rounded-lg border border-border bg-surface p-0.5">
                <ViewButton
                  active={activeView === "stdio"}
                  icon={<Radio className="size-4" />}
                  label="stdio 抓包"
                  mobileLabel="stdio"
                  onClick={() => selectView("stdio")}
                />
                <ViewButton
                  active={activeView === "protocol"}
                  icon={<Braces className="size-4" />}
                  label="协议字段"
                  mobileLabel="协议"
                  onClick={() => selectView("protocol")}
                />
                <ViewButton
                  active={activeView === "capabilities"}
                  icon={<Waypoints className="size-4" />}
                  label="能力地图"
                  mobileLabel="能力"
                  onClick={() => selectView("capabilities")}
                />
                <ViewButton
                  active={activeView === "boundary"}
                  icon={<GitBranch className="size-4" />}
                  label="Feature Boundary"
                  mobileLabel="边界"
                  onClick={() => selectView("boundary")}
                />
              </nav>
              {activeView === "protocol" ? (
                <label className="relative min-w-0 flex-1 md:w-80 md:flex-none">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtlest" />
                  <input
                    className="h-8 w-full rounded-lg border border-input-border bg-input pl-8 pr-3 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused focus:bg-input-focused"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索字段、结构、概念"
                  />
                </label>
              ) : null}
              <button
                className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-surface text-foreground hover:bg-surface-hover"
                type="button"
                onClick={() => setIsDark((value) => !value)}
                aria-label={isDark ? "切换浅色主题" : "切换深色主题"}
                title={isDark ? "切换浅色主题" : "切换深色主题"}
              >
                {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </button>
            </div>
          </div>
        </header>

        {activeView === "stdio" ? (
          <StdioTrafficView />
        ) : activeView === "boundary" ? (
          <Suspense
            fallback={
              <main className="grid min-h-[680px] place-items-center p-4 text-ui-base text-foreground-subtle">
                正在加载 Feature Boundary 图谱…
              </main>
            }
          >
            <FeatureBoundaryGraphView />
          </Suspense>
        ) : activeView === "capabilities" ? (
          <Suspense
            fallback={
              <main className="grid min-h-[680px] place-items-center p-4 text-ui-base text-foreground-subtle">
                正在加载能力地图…
              </main>
            }
          >
            <CapabilityMapView />
          </Suspense>
        ) : (
          <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[240px_minmax(0,1fr)_300px]">
            <aside className="hidden lg:block">
              <div className="sticky top-20 rounded-lg border border-card-border bg-card p-2">
                <div className="px-2 py-1 text-ui-sm font-medium text-foreground-subtle">
                  结构目录
                </div>
                <nav className="mt-1 flex flex-col gap-1">
                  {structures.map((structure) => (
                    <a
                      className="rounded-md px-2 py-1.5 text-ui-sm text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
                      href={`#${structure.id}`}
                      key={structure.id}
                    >
                      {structure.title}
                    </a>
                  ))}
                </nav>
              </div>
            </aside>

            <div className="min-w-0 space-y-4">
              <section className="rounded-lg border border-card-border bg-card p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="mb-2 flex items-center gap-2 text-ui-sm font-medium text-brand">
                      <GitCompareArrows className="size-4" />
                      数据结构迁移
                    </div>
                    <h2 className="text-ui-lg font-medium">
                      从 `traceId` 混用到 `traceId + inputId` 双轴模型
                    </h2>
                    <p className="mt-2 max-w-3xl text-ui-base leading-6 text-foreground-subtle">
                      这次变更把“观测链路”和“用户输入归属”拆开：`traceId`
                      保持日志与协议事件追踪，`inputId` 负责每次发送、排队、stop
                      和终态收口。`sessionId` 仍是 agent server 生成的会话主键。
                    </p>
                  </div>
                  <div className="grid min-w-56 gap-2 rounded-lg border border-border bg-surface p-3 text-ui-sm">
                    <Metric label="结构" value={String(structures.length)} />
                    <Metric label="概念" value={String(concepts.length)} />
                    <Metric label="协议面" value={String(protocolSurfaces.length)} />
                  </div>
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-3">
                <SummaryCard
                  icon={<Hash className="size-4" />}
                  title="sessionId"
                  body="会话主键，server 生成。UI/task 进入 ZCode Protocol 前必须拿到它。"
                  conceptId="sessionId"
                  onSelect={setActiveConceptId}
                />
                <SummaryCard
                  icon={<Network className="size-4" />}
                  title="traceId"
                  body="观测链路，UUID 格式，不再用作每次 prompt 的 run id。"
                  conceptId="traceId"
                  onSelect={setActiveConceptId}
                />
                <SummaryCard
                  icon={<Boxes className="size-4" />}
                  title="inputId"
                  body="每次用户输入的归属，贯穿 send、turn event、stream event 和 UI 收口。"
                  conceptId="inputId"
                  onSelect={setActiveConceptId}
                />
              </section>

              <section className="rounded-lg border border-card-border bg-card p-4" id="flow">
                <div className="mb-3 flex items-center gap-2">
                  <Braces className="size-4 text-brand" />
                  <h2 className="text-ui-base font-medium">发送链路</h2>
                </div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {flows.map((step, index) => (
                    <div className="rounded-lg border border-border bg-surface p-3" key={step.id}>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="font-mono text-ui-sm text-foreground-subtle">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="rounded-full border border-border px-2 py-0.5 text-ui-sm text-foreground-subtle">
                          {step.actor}
                        </span>
                      </div>
                      <h3 className="text-ui-base font-medium">{step.title}</h3>
                      <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">
                        {step.detail}
                      </p>
                      <ConceptLinks
                        ids={step.conceptIds}
                        activeId={activeConceptId}
                        onSelect={setActiveConceptId}
                      />
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-4">
                {filteredStructures.map((structure) => (
                  <StructureSection
                    activeConceptId={activeConceptId}
                    key={structure.id}
                    onSelectConcept={setActiveConceptId}
                    structure={structure}
                  />
                ))}
                {filteredStructures.length === 0 ? (
                  <div className="rounded-lg border border-card-border bg-card p-4 text-ui-base text-foreground-subtle">
                    没有匹配的数据结构。
                  </div>
                ) : null}
              </section>
            </div>

            <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
              <ConceptPanel
                activeConcept={activeConcept}
                activeConceptId={activeConceptId}
                filteredConcepts={filteredConcepts}
                onSelect={setActiveConceptId}
              />
              <ProtocolPanel activeConceptId={activeConceptId} onSelect={setActiveConceptId} />
            </aside>
          </main>
        )}
      </div>
    </div>
  );
}

function ViewButton({
  active,
  icon,
  label,
  mobileLabel,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  mobileLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-ui-sm ${
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{mobileLabel ?? label}</span>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-foreground-subtle">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

function SummaryCard({
  body,
  conceptId,
  icon,
  onSelect,
  title,
}: {
  body: string;
  conceptId: string;
  icon: ReactNode;
  onSelect: (conceptId: string) => void;
  title: string;
}) {
  return (
    <a
      className="group rounded-lg border border-card-border bg-card p-4 hover:border-border-hover hover:bg-card-selected"
      href={`#concept-${conceptId}`}
      onClick={() => onSelect(conceptId)}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="grid size-8 place-items-center rounded-lg border border-border bg-surface text-brand">
          {icon}
        </div>
        <ArrowRight className="size-4 text-foreground-subtlest group-hover:text-foreground" />
      </div>
      <h3 className="font-mono text-ui-base font-medium">{title}</h3>
      <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{body}</p>
    </a>
  );
}

function StructureSection({
  activeConceptId,
  onSelectConcept,
  structure,
}: {
  activeConceptId: string;
  onSelectConcept: (conceptId: string) => void;
  structure: StructureDoc;
}) {
  return (
    <article
      className="scroll-mt-20 rounded-lg border border-card-border bg-card"
      id={structure.id}
    >
      <div className="border-b border-border p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <BookOpenText className="size-4 text-brand" />
          <h2 className="text-ui-base font-medium">{structure.title}</h2>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-ui-sm text-foreground-subtle">
            {structure.path}
          </span>
        </div>
        <p className="text-ui-base leading-6 text-foreground-subtle">{structure.purpose}</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {structure.oldShape ? (
            <CodePanel label="旧结构" value={structure.oldShape} />
          ) : (
            <CodePanel label="旧结构" value="无直接旧结构，属于新增协议结构说明。" />
          )}
          <CodePanel label="新结构" value={structure.newShape} />
        </div>
        <div className="mt-3 rounded-lg border border-border bg-accent/60 p-3 text-ui-sm leading-5 text-foreground">
          {structure.migration}
        </div>
      </div>
      <FieldTable
        activeConceptId={activeConceptId}
        fields={structure.fields}
        onSelectConcept={onSelectConcept}
      />
    </article>
  );
}

function CodePanel({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 text-ui-sm font-medium text-foreground-subtle">{label}</div>
      <code className="block whitespace-pre-wrap break-words font-mono text-ui-sm leading-5 text-foreground">
        {value}
      </code>
    </div>
  );
}

function FieldTable({
  activeConceptId,
  fields,
  onSelectConcept,
}: {
  activeConceptId: string;
  fields: FieldDoc[];
  onSelectConcept: (conceptId: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] border-collapse text-left text-ui-sm">
        <thead className="bg-surface text-foreground-subtle">
          <tr>
            <Th>字段</Th>
            <Th>类型</Th>
            <Th>状态</Th>
            <Th>含义</Th>
            <Th>Owner</Th>
            <Th>关联概念</Th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr className="border-t border-border align-top" key={`${field.name}-${field.source}`}>
              <td className="w-44 p-3">
                <div className="font-mono text-foreground">{field.name}</div>
                {field.oldName ? (
                  <div className="mt-1 font-mono text-foreground-subtlest">
                    old: {field.oldName}
                  </div>
                ) : null}
              </td>
              <td className="w-56 p-3 font-mono text-foreground-subtle">{field.type}</td>
              <td className="w-24 p-3">
                <RequiredBadge required={field.required} />
              </td>
              <td className="min-w-80 p-3">
                <p className="leading-5 text-foreground">{field.meaning}</p>
                {field.notes ? (
                  <p className="mt-1 leading-5 text-foreground-subtle">{field.notes}</p>
                ) : null}
                <p className="mt-1 font-mono text-ui-xs leading-5 text-foreground-subtlest">
                  {field.source}
                </p>
              </td>
              <td className="w-36 p-3 text-foreground-subtle">{field.owner}</td>
              <td className="w-56 p-3">
                <ConceptLinks
                  activeId={activeConceptId}
                  ids={field.conceptIds}
                  onSelect={onSelectConcept}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="border-b border-border px-3 py-2 font-medium">{children}</th>;
}

function RequiredBadge({ required }: { required: FieldDoc["required"] }) {
  const label = required === "required" ? "必填" : required === "optional" ? "可选" : "兼容";
  const className =
    required === "required"
      ? "border-brand/35 bg-brand/12 text-foreground"
      : required === "optional"
        ? "border-border bg-surface text-foreground-subtle"
        : "border-warning/35 bg-warning/12 text-foreground";
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 ${className}`}>{label}</span>
  );
}

function ConceptLinks({
  activeId,
  ids,
  onSelect,
}: {
  activeId: string;
  ids: string[];
  onSelect: (conceptId: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const concept = conceptById.get(id);
        const active = id === activeId;
        return (
          <a
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-ui-xs ${
              active
                ? "border-brand bg-brand text-foreground-inverse"
                : "border-border bg-tag text-foreground"
            }`}
            href={`#concept-${id}`}
            key={id}
            onClick={() => onSelect(id)}
            title={concept?.summary ?? id}
          >
            <LinkIcon className="size-3" />
            {concept?.name ?? id}
          </a>
        );
      })}
    </div>
  );
}

function ConceptPanel({
  activeConcept,
  activeConceptId,
  filteredConcepts,
  onSelect,
}: {
  activeConcept: Concept | undefined;
  activeConceptId: string;
  filteredConcepts: Concept[];
  onSelect: (conceptId: string) => void;
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card">
      <div className="border-b border-border p-3">
        <div className="mb-1 flex items-center gap-2 text-ui-sm font-medium text-brand">
          <Hash className="size-4" />
          概念索引
        </div>
        {activeConcept ? (
          <div className="scroll-mt-20" id={`concept-${activeConcept.id}`}>
            <div className="mt-2 flex items-center gap-2">
              <code className="font-mono text-ui-base font-medium">{activeConcept.name}</code>
              <span
                className={`rounded-full border px-2 py-0.5 text-ui-xs ${kindClassName[activeConcept.kind]}`}
              >
                {kindLabel[activeConcept.kind]}
              </span>
            </div>
            <p className="mt-2 text-ui-sm leading-5 text-foreground-subtle">
              {activeConcept.summary}
            </p>
            <dl className="mt-3 grid gap-2 text-ui-sm">
              <DetailRow label="生命周期" value={activeConcept.lifecycle} />
              <DetailRow label="Owner" value={activeConcept.owner} />
              <DetailRow label="来源" value={activeConcept.source} mono />
            </dl>
            {activeConcept.related.length > 0 ? (
              <ConceptLinks
                activeId={activeConceptId}
                ids={activeConcept.related}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="max-h-[420px] overflow-y-auto p-2">
        {filteredConcepts.map((concept) => (
          <a
            className={`mb-1 block rounded-md px-2 py-1.5 text-ui-sm ${
              concept.id === activeConceptId
                ? "bg-selected text-foreground"
                : "text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
            }`}
            href={`#concept-${concept.id}`}
            key={concept.id}
            onClick={() => onSelect(concept.id)}
          >
            <span className="font-mono">{concept.name}</span>
            <span className="ml-2 text-foreground-subtlest">{kindLabel[concept.kind]}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function DetailRow({ label, mono, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div>
      <dt className="text-foreground-subtlest">{label}</dt>
      <dd className={`mt-0.5 leading-5 text-foreground ${mono ? "font-mono text-ui-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function ProtocolPanel({
  activeConceptId,
  onSelect,
}: {
  activeConceptId: string;
  onSelect: (conceptId: string) => void;
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card p-3">
      <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
        <Network className="size-4" />
        @zcode/protocol
      </div>
      <div className="space-y-2">
        {protocolSurfaces.map((surface) => (
          <div className="rounded-lg border border-border bg-surface p-3" key={surface.id}>
            <h3 className="text-ui-base font-medium">{surface.title}</h3>
            <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{surface.summary}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {surface.fields.map((field) => (
                <span
                  className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle"
                  key={field}
                >
                  {field}
                </span>
              ))}
            </div>
            <ConceptLinks activeId={activeConceptId} ids={surface.conceptIds} onSelect={onSelect} />
          </div>
        ))}
      </div>
    </section>
  );
}

function StdioTrafficView() {
  const initialFrames = useMemo(() => sortTrafficFramesByNewest(stdioTrafficFrames), []);
  const [trafficFrames, setTrafficFrames] = useState<StdioTrafficFrame[]>([]);
  const [trafficQuery, setTrafficQuery] = useState("");
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  const [trafficSourceMode, setTrafficSourceMode] = useState<TrafficSourceMode>("real");
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [selectedFrameId, setSelectedFrameId] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState("--:--:--.---");
  const [realTraffic, setRealTraffic] = useState<RealTrafficState>({
    status: "loading",
    logDir: "~/.zcode/v2/dev/stdio-traffic",
    records: [],
  });
  const liveSequenceRef = useRef(0);
  const normalizedTrafficQuery = normalizeText(trafficQuery);
  const latestFrame = trafficFrames[0];
  const isMockReplayEnabled = trafficSourceMode === "mock";

  const fetchRealTraffic = useCallback(async () => {
    try {
      const response = await fetch("/api/dev/stdio-traffic?limit=400", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as StdioTrafficApiResponse;
      setRealTraffic({
        status: data.status,
        logDir: data.logDir,
        records: Array.isArray(data.records) ? data.records : [],
        error: data.error,
        filePath: data.filePath,
        updatedAt: data.updatedAt,
        workspaceHash: data.workspaceHash,
      });
    } catch (error) {
      setRealTraffic((current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        records: [],
      }));
    }
  }, []);

  useEffect(() => {
    if (trafficSourceMode !== "real") {
      return;
    }

    void fetchRealTraffic();
    const timer = window.setInterval(() => {
      void fetchRealTraffic();
    }, 1000);

    return () => window.clearInterval(timer);
  }, [fetchRealTraffic, trafficSourceMode]);

  useEffect(() => {
    if (trafficSourceMode !== "real") {
      return;
    }

    const realFrames = sortTrafficFramesByNewest(mapRealTrafficFrames(realTraffic));
    setTrafficFrames(realFrames);
    setLastUpdatedAt(
      realTraffic.updatedAt
        ? formatIsoTrafficTimestamp(realTraffic.updatedAt)
        : (realFrames[0]?.timestamp ?? "--:--:--.---"),
    );
    setSelectedFrameId((currentFrameId) =>
      isFollowingLatest || !realFrames.some((frame) => frame.id === currentFrameId)
        ? (realFrames[0]?.id ?? "")
        : currentFrameId,
    );
  }, [isFollowingLatest, realTraffic, trafficSourceMode]);

  useEffect(() => {
    if (!isMockReplayEnabled) {
      return;
    }

    // mock replay 只用于演示；真实调试默认走 Vite 本地 API 读取 tap proxy 的 NDJSON。
    const timer = window.setInterval(() => {
      liveSequenceRef.current += 1;
      const nextFrame = createLiveStdioTrafficFrame(
        liveSequenceRef.current,
        formatTrafficTimestamp(new Date()),
      );

      setTrafficFrames((currentFrames) =>
        sortTrafficFramesByNewest([nextFrame, ...currentFrames]).slice(0, 48),
      );
      setLastUpdatedAt(nextFrame.timestamp);

      if (isFollowingLatest) {
        setSelectedFrameId(nextFrame.id);
      }
    }, 1800);

    return () => window.clearInterval(timer);
  }, [isFollowingLatest, isMockReplayEnabled]);

  const followLatest = () => {
    setIsFollowingLatest(true);
    setSelectedFrameId(trafficFrames[0]?.id ?? "");
  };

  const startMockReplay = () => {
    liveSequenceRef.current = 0;
    setTrafficFrames(initialFrames);
    setLastUpdatedAt(initialFrames[0]?.timestamp ?? "--:--:--.---");
    setIsFollowingLatest(true);
    setTrafficSourceMode("mock");
    setSelectedFrameId(initialFrames[0]?.id ?? "");
  };

  const stopMockReplay = () => {
    liveSequenceRef.current = 0;
    setTrafficSourceMode("real");
    void fetchRealTraffic();
  };

  const refreshTrafficSource = () => {
    if (trafficSourceMode === "mock") {
      startMockReplay();
      return;
    }

    void fetchRealTraffic();
  };

  const filteredFrames = useMemo(
    () =>
      sortTrafficFramesByNewest(
        trafficFrames.filter((frame) => {
          const directionMatches = directionFilter === "all" || frame.direction === directionFilter;
          if (!directionMatches) {
            return false;
          }
          if (!normalizedTrafficQuery) {
            return true;
          }
          const haystack = [
            frame.id,
            frame.timestamp,
            frame.direction,
            frame.kind,
            frame.method ?? "",
            frame.messageId ?? "",
            frame.sessionId ?? "",
            frame.inputId ?? "",
            frame.summary,
            frame.raw,
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(normalizedTrafficQuery);
        }),
      ),
    [directionFilter, normalizedTrafficQuery, trafficFrames],
  );

  const selectedFrame =
    filteredFrames.find((frame) => frame.id === selectedFrameId) ??
    trafficFrames.find((frame) => frame.id === selectedFrameId) ??
    filteredFrames[0] ??
    trafficFrames[0];

  const linkedFrame = selectedFrame?.linkedId
    ? trafficFrames.find((frame) => frame.id === selectedFrame.linkedId)
    : undefined;
  const trafficStatusLabel =
    trafficSourceMode === "mock"
      ? "mock replay"
      : realTraffic.status === "ready"
        ? "real tail"
        : realTraffic.status;
  const trafficStatusClassName =
    trafficSourceMode === "mock"
      ? "border-warning/35 bg-warning/12 text-foreground"
      : realTraffic.status === "ready"
        ? "border-success/35 bg-success/12 text-foreground"
        : "border-border bg-surface text-foreground-subtle";
  const sourcePath =
    trafficSourceMode === "mock"
      ? "mock replay"
      : (realTraffic.filePath ?? realTraffic.logDir ?? "~/.zcode/v2/dev/stdio-traffic");
  const emptyTrafficMessage =
    trafficSourceMode === "mock"
      ? "mock replay 暂无 frame。"
      : realTraffic.status === "missing"
        ? "没有找到 stdio tap 文件。先在开发环境 Help 里打开抓取开关并启动一个 agent。"
        : realTraffic.status === "error"
          ? `读取 stdio tap 失败：${realTraffic.error ?? "unknown error"}`
          : "等待真实 stdio traffic。";

  return (
    <main className="grid w-full gap-4 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <section className="rounded-lg border border-card-border bg-card">
          <div className="border-b border-border p-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-2">
                <Activity className="size-4 text-brand" />
                <h2 className="whitespace-nowrap text-ui-lg font-medium">Traffic Inspector</h2>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-ui-xs ${trafficStatusClassName}`}
                >
                  {trafficStatusLabel}
                </span>
                <span className="font-mono text-ui-sm text-foreground-subtle">
                  latest {lastUpdatedAt}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <label className="relative min-w-0 sm:w-72">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtlest" />
                  <input
                    className="h-8 w-full rounded-lg border border-input-border bg-input pl-8 pr-3 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused focus:bg-input-focused"
                    value={trafficQuery}
                    onChange={(event) => setTrafficQuery(event.target.value)}
                    placeholder="搜索 method、id、inputId、raw"
                  />
                </label>
                <div className="flex rounded-lg border border-border bg-surface p-0.5">
                  <DirectionButton
                    active={directionFilter === "all"}
                    icon={<ListFilter className="size-3.5" />}
                    label="全部"
                    onClick={() => setDirectionFilter("all")}
                  />
                  <DirectionButton
                    active={directionFilter === "app-to-agent"}
                    icon={<ArrowUp className="size-3.5" />}
                    label="上行"
                    onClick={() => setDirectionFilter("app-to-agent")}
                  />
                  <DirectionButton
                    active={directionFilter === "agent-to-app"}
                    icon={<ArrowDown className="size-3.5" />}
                    label="下行"
                    onClick={() => setDirectionFilter("agent-to-app")}
                  />
                  <DirectionButton
                    active={directionFilter === "agent-stderr"}
                    icon={<Terminal className="size-3.5" />}
                    label="stderr"
                    onClick={() => setDirectionFilter("agent-stderr")}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="grid min-h-[calc(100dvh-160px)] lg:grid-cols-[minmax(0,0.9fr)_minmax(520px,1.1fr)]">
            <div className="min-w-0 border-b border-border lg:border-b-0 lg:border-r">
              <div className="grid grid-cols-[84px_120px_minmax(0,1fr)_88px] border-b border-border bg-surface px-3 py-2 text-ui-sm font-medium text-foreground-subtle">
                <span>时间</span>
                <span>方向</span>
                <span>方法 / 摘要</span>
                <span className="text-right">大小</span>
              </div>
              <div className="max-h-[520px] overflow-y-auto">
                {filteredFrames.map((frame) => (
                  <TrafficFrameRow
                    active={frame.id === selectedFrame?.id}
                    frame={frame}
                    key={frame.id}
                    onSelect={() => {
                      setSelectedFrameId(frame.id);
                      setIsFollowingLatest(frame.id === trafficFrames[0]?.id);
                    }}
                  />
                ))}
                {filteredFrames.length === 0 ? (
                  <div className="p-4 text-ui-base text-foreground-subtle">
                    {emptyTrafficMessage}
                  </div>
                ) : null}
              </div>
            </div>

            <TrafficFrameDetail frame={selectedFrame} linkedFrame={linkedFrame} />
          </div>
        </section>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <section className="rounded-lg border border-card-border bg-card p-3">
          <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
            <HardDrive className="size-4" />
            Tail Source
          </div>
          <div className="grid gap-2">
            <TrafficStat label="状态" value={trafficStatusLabel} />
            <TrafficStat label="跟随" value={isFollowingLatest ? "latest" : "selected"} />
            <TrafficStat label="帧数" value={String(trafficFrames.length)} />
            <TrafficStat
              label="最新方向"
              value={latestFrame ? directionLabel[latestFrame.direction] : "-"}
            />
            <TrafficStat label="workspaceHash" value={realTraffic.workspaceHash ?? "-"} />
          </div>
          <div className="mt-3 rounded-lg border border-border bg-surface p-2">
            <div className="mb-1 flex items-center gap-2 text-ui-sm font-medium text-foreground-subtle">
              <Terminal className="size-4" />
              source
            </div>
            <code className="block break-words font-mono text-ui-xs leading-5 text-foreground">
              {sourcePath}
            </code>
          </div>
        </section>

        <section className="rounded-lg border border-card-border bg-card p-3">
          <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
            <Filter className="size-4" />
            Controls
          </div>
          <div className="grid gap-2">
            <InspectorAction
              active={isFollowingLatest}
              icon={<Radio className="size-4" />}
              label="Follow latest"
              onClick={followLatest}
            />
            <InspectorAction
              active={isMockReplayEnabled}
              icon={
                isMockReplayEnabled ? <Pause className="size-4" /> : <Play className="size-4" />
              }
              label={isMockReplayEnabled ? "Stop mock replay" : "Start mock replay"}
              onClick={isMockReplayEnabled ? stopMockReplay : startMockReplay}
            />
            <InspectorAction
              icon={<FileJson className="size-4" />}
              label={trafficSourceMode === "mock" ? "Reset mock" : "Reload real source"}
              onClick={refreshTrafficSource}
            />
          </div>
        </section>

        <section className="rounded-lg border border-card-border bg-card p-3">
          <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
            <Database className="size-4" />
            record 字段
          </div>
          <div className="space-y-2">
            {stdioTrafficLogFields.map((field) => (
              <div className="rounded-lg border border-border bg-surface p-2" key={field.name}>
                <div className="flex items-center justify-between gap-2">
                  <code className="font-mono text-ui-sm text-foreground">{field.name}</code>
                  <span className="font-mono text-ui-xs text-foreground-subtlest">
                    {field.type}
                  </span>
                </div>
                <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{field.meaning}</p>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </main>
  );
}

function TrafficStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-ui-sm text-foreground-subtle">{label}</div>
      <div className="mt-1 truncate font-mono text-ui-base text-foreground" title={value}>
        {value}
      </div>
    </div>
  );
}

function DirectionButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-ui-sm whitespace-nowrap ${
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function TrafficFrameRow({
  active,
  frame,
  onSelect,
}: {
  active: boolean;
  frame: StdioTrafficFrame;
  onSelect: () => void;
}) {
  return (
    <button
      className={`grid w-full grid-cols-[84px_120px_minmax(0,1fr)_88px] items-start gap-0 border-b border-border px-3 py-2 text-left hover:bg-surface-hover ${
        active ? "bg-selected" : ""
      }`}
      type="button"
      onClick={onSelect}
    >
      <span className="font-mono text-ui-sm text-foreground-subtle">{frame.timestamp}</span>
      <span
        className={`mr-2 inline-flex w-fit rounded-full border px-2 py-0.5 font-mono text-ui-xs ${directionClassName[frame.direction]}`}
      >
        {directionLabel[frame.direction]}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-mono text-ui-sm text-foreground">
          {frame.method ?? frame.kind}
          {frame.messageId ? (
            <span className="text-foreground-subtlest"> #{frame.messageId}</span>
          ) : null}
        </span>
        <span className="mt-1 block truncate text-ui-sm text-foreground-subtle">
          {frame.summary}
        </span>
      </span>
      <span className="text-right font-mono text-ui-sm text-foreground-subtle">{frame.bytes}b</span>
    </button>
  );
}

function TrafficFrameDetail({
  frame,
  linkedFrame,
}: {
  frame: StdioTrafficFrame | undefined;
  linkedFrame: StdioTrafficFrame | undefined;
}) {
  if (!frame) {
    return (
      <div className="p-4 text-ui-base text-foreground-subtle">请选择一条 traffic frame。</div>
    );
  }

  return (
    <aside className="min-w-0 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-ui-xs ${directionClassName[frame.direction]}`}
            >
              {directionLabel[frame.direction]}
            </span>
            <span className="font-mono text-ui-sm text-foreground-subtle">{frame.timestamp}</span>
          </div>
          <h3 className="truncate text-ui-base font-medium">{frame.method ?? frame.kind}</h3>
          <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{frame.summary}</p>
        </div>
      </div>

      <div className="grid gap-2 text-ui-sm">
        <DetailPill label="kind" value={frame.kind} />
        {frame.messageId ? <DetailPill label="id" value={frame.messageId} /> : null}
        {frame.sessionId ? <DetailPill label="session" value={frame.sessionId} /> : null}
        {frame.inputId ? <DetailPill label="input" value={frame.inputId} /> : null}
        {typeof frame.latencyMs === "number" ? (
          <DetailPill label="latency" value={`${frame.latencyMs}ms`} />
        ) : null}
      </div>

      {linkedFrame ? (
        <div className="mt-3 rounded-lg border border-border bg-surface p-3">
          <div className="mb-1 flex items-center gap-2 text-ui-sm font-medium text-foreground">
            <GitCompareArrows className="size-4 text-brand" />
            配对帧
          </div>
          <p className="font-mono text-ui-sm text-foreground-subtle">
            {linkedFrame.timestamp} · {linkedFrame.method ?? linkedFrame.kind}
            {linkedFrame.messageId ? ` #${linkedFrame.messageId}` : ""}
          </p>
          <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{linkedFrame.summary}</p>
        </div>
      ) : null}

      <div className="mt-3">
        <div className="mb-2 flex items-center gap-2 text-ui-sm font-medium text-foreground-subtle">
          <FileJson className="size-4" />
          raw line
        </div>
        <code className="block max-h-[calc(100dvh-420px)] min-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 font-mono text-ui-sm leading-5 text-foreground">
          {formatRawLine(frame.raw)}
        </code>
      </div>
    </aside>
  );
}

function DetailPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-2 py-1.5">
      <span className="text-foreground-subtle">{label}</span>
      <span className="min-w-0 truncate font-mono text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}

function InspectorAction({
  active = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex h-8 items-center gap-2 rounded-md border px-2 text-left text-ui-sm text-foreground hover:bg-surface-hover ${
        active ? "border-brand/35 bg-selected" : "border-border bg-surface"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
