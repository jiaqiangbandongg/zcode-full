import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  getFeatureBoundaryGraphStats,
  getFeatureBoundaryNeighborhood,
  type FeatureBoundaryGraph,
} from "@/data/featureBoundaryGraph.js";
import { normalizeFeatureBoundaryGraph } from "@/data/featureBoundaryGraphSource.js";

const fixture: FeatureBoundaryGraph = {
  schemaVersion: 1,
  graphId: "fixture",
  purpose: "test",
  nodes: [
    {
      id: "capability.alpha",
      kind: "capability",
      label: "Alpha",
      aliases: [],
      docs: [],
      codeSeeds: [],
      invariants: [],
    },
    {
      id: "service.beta",
      kind: "service",
      label: "Beta",
      aliases: [],
      docs: [],
      codeSeeds: [],
      invariants: [],
    },
    {
      id: "state.gamma",
      kind: "state-owner",
      label: "Gamma",
      aliases: [],
      docs: [],
      codeSeeds: [],
      invariants: [],
    },
  ],
  edges: [
    {
      from: "capability.alpha",
      to: "service.beta",
      type: "served-by",
      rank: "must-inspect",
    },
    {
      from: "state.gamma",
      to: "capability.alpha",
      type: "projects-to",
      rank: "should-inspect",
    },
  ],
};

describe("feature boundary graph helpers", () => {
  it("保留节点、边和按类型统计", () => {
    expect(getFeatureBoundaryGraphStats(fixture)).toEqual({
      nodeCount: 3,
      edgeCount: 2,
      unresolvedEndpointCount: 0,
      kindCounts: {
        capability: 1,
        service: 1,
        "state-owner": 1,
      },
    });
  });

  it("返回选中节点的一阶邻居，并补出未声明端点", () => {
    const graph: FeatureBoundaryGraph = {
      ...fixture,
      edges: [
        ...fixture.edges,
        {
          from: "capability.alpha",
          to: "missing.delta",
          type: "depends-on",
          rank: "conditional",
        },
      ],
    };

    const neighborhood = getFeatureBoundaryNeighborhood(graph, "capability.alpha");
    expect(neighborhood.nodes.map((node) => node.id)).toEqual([
      "capability.alpha",
      "service.beta",
      "state.gamma",
      "missing.delta",
    ]);
    expect(neighborhood.edges).toHaveLength(3);
    expect(neighborhood.edges[2]).toMatchObject({
      source: "capability.alpha",
      target: "missing.delta",
    });
  });

  it("解析当前 feature boundary YAML 并保留未声明端点", async () => {
    const source = await readFile(
      resolve(
        process.cwd(),
        "../../.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml",
      ),
      "utf8",
    );
    const graph = normalizeFeatureBoundaryGraph(parseYaml(source));
    const stats = getFeatureBoundaryGraphStats(graph);

    expect(stats).toMatchObject({
      nodeCount: 324,
      edgeCount: 629,
      unresolvedEndpointCount: 2,
    });
    expect(graph.nodes.filter((node) => node.kind === "unresolved").map((node) => node.id)).toEqual(
      ["capability.mcp-oauth-authorization", "persistence.desktop-user-data-root"],
    );
  });

  it("危险命令 V1 关联真实代码起点和隔离边界", async () => {
    const source = await readFile(
      resolve(
        process.cwd(),
        "../../.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml",
      ),
      "utf8",
    );
    const graph = normalizeFeatureBoundaryGraph(parseYaml(source));
    const capabilityId = "capability.dangerous-command-approval";
    const capability = graph.nodes.find((node) => node.id === capabilityId);
    expect(capability?.docs).toContain("docs/dangerous-command-approval-v1-plan.md");
    expect(capability?.codeSeeds).toEqual([
      "matchDangerousCommand · apps/zcode-cli/packages/core/src/tool/handlers/guarded/command.ts",
      "resolveToolPermission · apps/zcode-cli/packages/core/src/tool/executor/permission-flow.ts",
      "buildProtocolPermissionOptions · apps/zcode-cli/packages/bootstrap/src/permission-options.ts",
      "getZCodeAgentAvailableModes · packages/shared/src/zcode-agent-model-state.ts",
      "buildAutomationModeOption · packages/ui/src/settings/automationAgentConfigOptions.ts",
      "filterModeOptions · apps/zcode-cli/packages/tui/src/app-mode-command.ts",
    ]);
    expect(graph.edges.filter((edge) => edge.from === capabilityId).map((edge) => edge.to)).toEqual(
      [
        "surface.parent-task-blocking-interaction",
        "boundary.desktop-continuous",
        "boundary.web-remote-replayable",
        "boundary.workspace-key",
      ],
    );
  });
});
