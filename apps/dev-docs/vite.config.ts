import { readdir, readFile, stat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { parse as parseYaml } from "yaml";
import { normalizeFeatureBoundaryGraph } from "./src/data/featureBoundaryGraphSource.js";

const STDIO_TRAFFIC_API_PATH = "/api/dev/stdio-traffic";
const STDIO_TRAFFIC_LOG_DIR = join(homedir(), ".zcode", "v2", "dev", "stdio-traffic");
const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_RECORD_LIMIT = 300;
const FEATURE_BOUNDARY_GRAPH_MODULE_ID = "virtual:zcode-feature-boundary-graph";
const FEATURE_BOUNDARY_GRAPH_RESOLVED_ID = `\0${FEATURE_BOUNDARY_GRAPH_MODULE_ID}`;
const FEATURE_BOUNDARY_GRAPH_SOURCE_PATH = resolve(
  __dirname,
  "../../.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml",
);

interface StdioTrafficFile {
  filePath: string;
  mtimeMs: number;
  workspaceHash: string;
}

function sendJson(
  response: { setHeader: (name: string, value: string) => void; end: (body: string) => void },
  body: unknown,
) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

async function fileExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readLatestPointer(workspaceDir: string) {
  const latestPath = join(workspaceDir, "latest.txt");
  if (!(await fileExists(latestPath))) {
    return null;
  }

  const filePath = (await readFile(latestPath, "utf-8")).trim().split(/\r?\n/u)[0] ?? "";
  if (!filePath || extname(filePath) !== ".ndjson" || dirname(filePath) !== workspaceDir) {
    return null;
  }

  return filePath;
}

async function findWorkspaceLatestFile(logDir: string, workspaceHash: string) {
  const workspaceDir = join(logDir, workspaceHash);
  const latestFilePath = await readLatestPointer(workspaceDir);
  const candidates: StdioTrafficFile[] = [];

  if (latestFilePath && (await fileExists(latestFilePath))) {
    const fileStat = await stat(latestFilePath);
    candidates.push({ filePath: latestFilePath, mtimeMs: fileStat.mtimeMs, workspaceHash });
  }

  if (candidates.length === 0) {
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ndjson")) {
        continue;
      }
      const filePath = join(workspaceDir, entry.name);
      const fileStat = await stat(filePath);
      candidates.push({ filePath, mtimeMs: fileStat.mtimeMs, workspaceHash });
    }
  }

  return candidates.sort((first, second) => second.mtimeMs - first.mtimeMs)[0] ?? null;
}

async function findLatestTrafficFile(logDir: string) {
  if (!(await fileExists(logDir))) {
    return null;
  }

  const entries = await readdir(logDir, { withFileTypes: true });
  const candidates: StdioTrafficFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const latestFile = await findWorkspaceLatestFile(logDir, entry.name);
    if (latestFile) {
      candidates.push(latestFile);
    }
  }

  return candidates.sort((first, second) => second.mtimeMs - first.mtimeMs)[0] ?? null;
}

async function readTailLines(filePath: string, limit: number) {
  const fileStat = await stat(filePath);
  if (fileStat.size === 0) {
    return [];
  }

  const start = Math.max(0, fileStat.size - MAX_TAIL_BYTES);
  const length = fileStat.size - start;
  const buffer = Buffer.alloc(length);
  const file = await open(filePath, "r");
  try {
    await file.read(buffer, 0, length, start);
  } finally {
    await file.close();
  }

  let text = buffer.toString("utf-8");
  if (start > 0) {
    const firstLineBreak = text.indexOf("\n");
    text = firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : "";
  }

  return text.split(/\r?\n/u).filter(Boolean).slice(-limit);
}

async function buildFeatureBoundaryGraphModule() {
  const source = await readFile(FEATURE_BOUNDARY_GRAPH_SOURCE_PATH, "utf-8");
  const graph = normalizeFeatureBoundaryGraph(parseYaml(source));
  return `export default ${JSON.stringify(graph)};`;
}

function featureBoundaryGraphPlugin(): Plugin {
  let moduleSource = "";
  return {
    name: "zcode-dev-docs-feature-boundary-graph",
    configureServer(server) {
      server.watcher.add(FEATURE_BOUNDARY_GRAPH_SOURCE_PATH);
    },
    async buildStart() {
      moduleSource = await buildFeatureBoundaryGraphModule();
    },
    resolveId(id) {
      return id === FEATURE_BOUNDARY_GRAPH_MODULE_ID
        ? FEATURE_BOUNDARY_GRAPH_RESOLVED_ID
        : undefined;
    },
    async load(id) {
      if (id !== FEATURE_BOUNDARY_GRAPH_RESOLVED_ID) {
        return undefined;
      }
      if (!moduleSource) {
        moduleSource = await buildFeatureBoundaryGraphModule();
      }
      return moduleSource;
    },
    async handleHotUpdate({ file, server }) {
      if (resolve(file) !== FEATURE_BOUNDARY_GRAPH_SOURCE_PATH) {
        return undefined;
      }
      moduleSource = await buildFeatureBoundaryGraphModule();
      const module = server.moduleGraph.getModuleById(FEATURE_BOUNDARY_GRAPH_RESOLVED_ID);
      if (module) {
        server.moduleGraph.invalidateModule(module);
        return [module];
      }
      return undefined;
    },
  };
}

function parseRecordLines(lines: string[]) {
  return lines.flatMap((line, index) => {
    try {
      return [{ index, record: JSON.parse(line) as unknown }];
    } catch (error) {
      return [
        {
          index,
          record: {
            ts: new Date().toISOString(),
            direction: "agent-stderr",
            bytes: Buffer.byteLength(line),
            raw: line,
            parseError: error instanceof Error ? error.message : String(error),
          },
        },
      ];
    }
  });
}

function stdioTrafficApiPlugin(): Plugin {
  return {
    name: "zcode-dev-docs-stdio-traffic-api",
    configureServer(server) {
      server.middlewares.use(STDIO_TRAFFIC_API_PATH, async (request, response) => {
        try {
          const requestUrl = new URL(request.url ?? "", "http://localhost");
          const limit = Math.min(
            Number.parseInt(requestUrl.searchParams.get("limit") ?? "", 10) || DEFAULT_RECORD_LIMIT,
            1000,
          );
          const latestFile = await findLatestTrafficFile(STDIO_TRAFFIC_LOG_DIR);
          if (!latestFile) {
            sendJson(response, {
              status: "missing",
              logDir: STDIO_TRAFFIC_LOG_DIR,
              records: [],
            });
            return;
          }

          const lines = await readTailLines(latestFile.filePath, limit);
          sendJson(response, {
            status: lines.length > 0 ? "ready" : "empty",
            logDir: STDIO_TRAFFIC_LOG_DIR,
            workspaceHash: latestFile.workspaceHash,
            filePath: latestFile.filePath,
            updatedAt: new Date(latestFile.mtimeMs).toISOString(),
            records: parseRecordLines(lines),
          });
        } catch (error) {
          sendJson(response, {
            status: "error",
            logDir: STDIO_TRAFFIC_LOG_DIR,
            records: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [stdioTrafficApiPlugin(), featureBoundaryGraphPlugin(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5186,
  },
});
