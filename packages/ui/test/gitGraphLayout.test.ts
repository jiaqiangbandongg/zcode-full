import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { GitGraphPane } from "../src/git-graph/GitGraphPane.js";
import type { GitGraphCommit } from "../src/git-graph/layout.js";
import { layoutGitGraph } from "../src/git-graph/layout.js";

function commit(hash: string, parents: string[] = []): GitGraphCommit {
  return {
    hash,
    parents,
    refs: [],
    subject: `Commit ${hash}`,
    authorName: "ZCode",
    authoredAtMs: 1_766_955_000_000,
  };
}

describe("layoutGitGraph", () => {
  it("keeps linear history in a single lane", () => {
    const layout = layoutGitGraph([commit("c3", ["c2"]), commit("c2", ["c1"]), commit("c1")]);

    expect(layout.laneCount).toBe(1);
    expect(layout.rows.map((row) => row.laneIndex)).toEqual([0, 0, 0]);
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges.every((edge) => !edge.truncated)).toBe(true);
  });

  it("allocates a side lane for branch merge parents", () => {
    const layout = layoutGitGraph([
      commit("m", ["left", "right"]),
      commit("left", ["base"]),
      commit("right", ["base"]),
      commit("base", ["root"]),
      commit("root"),
    ]);

    expect(layout.laneCount).toBe(2);
    expect(layout.rows.map((row) => [row.commit.hash, row.laneIndex])).toEqual([
      ["m", 0],
      ["left", 0],
      ["right", 1],
      ["base", 0],
      ["root", 0],
    ]);
    expect(layout.edges.find((edge) => edge.fromHash === "m" && edge.toHash === "right")
      ?.toLaneIndex).toBe(1);
  });

  it("reuses active parent lanes across multiple side branches", () => {
    const layout = layoutGitGraph([
      commit("m", ["left", "right", "docs"]),
      commit("left", ["base"]),
      commit("right", ["base"]),
      commit("docs", ["base"]),
      commit("base"),
    ]);

    expect(layout.laneCount).toBe(3);
    expect(layout.rows.map((row) => [row.commit.hash, row.laneIndex])).toEqual([
      ["m", 0],
      ["left", 0],
      ["right", 1],
      ["docs", 2],
      ["base", 0],
    ]);
  });

  it("keeps a shared parent on the lower first-parent lane after side branches", () => {
    const layout = layoutGitGraph([
      commit("merge", ["main1", "feature2"]),
      commit("feature2", ["feature1"]),
      commit("feature1", ["root"]),
      commit("main1", ["root"]),
      commit("root"),
    ]);

    expect(layout.rows.map((row) => [row.commit.hash, row.laneIndex])).toEqual([
      ["merge", 0],
      ["feature2", 1],
      ["feature1", 1],
      ["main1", 0],
      ["root", 0],
    ]);
    expect(layout.edges.find((edge) => edge.fromHash === "feature1" && edge.toHash === "root")
      ?.toLaneIndex).toBe(0);
    expect(layout.edges.find((edge) => edge.fromHash === "main1" && edge.toHash === "root")
      ?.toLaneIndex).toBe(0);
    expect(
      layout.laneSegments.some(
        (segment) => segment.hash === "root" && segment.laneIndex === 0,
      ),
    ).toBe(true);
    expect(
      layout.paths.some(
        (path) =>
          path.relatedHashes.includes("feature1") &&
          path.relatedHashes.includes("root") &&
          path.path.includes("C"),
      ),
    ).toBe(true);
  });

  it("marks parent edges as truncated when the parent is outside the window", () => {
    const layout = layoutGitGraph([commit("head", ["outside", "outside-side"])]);

    expect(layout.edges).toHaveLength(2);
    expect(layout.edges[0]?.truncated).toBe(true);
    expect(layout.edges[0]?.toHash).toBe("outside");
    expect(layout.edges[1]?.truncated).toBe(true);
    expect(layout.edges[1]?.toLaneIndex).toBe(1);
    expect(layout.laneSegments).toHaveLength(0);
    expect(layout.paths).toHaveLength(0);
    expect(layout.laneCount).toBe(1);
  });

  it("keeps branch paths when a paged-in parent appears later", () => {
    const layout = layoutGitGraph([
      commit("merge", ["left", "right"]),
      commit("left", ["base"]),
      commit("right", ["base"]),
      commit("base"),
    ]);

    expect(
      layout.laneSegments.some(
        (segment) => segment.hash === "right" && segment.laneIndex === 1,
      ),
    ).toBe(true);
    expect(
      layout.paths.some(
        (path) =>
          path.relatedHashes.includes("right") &&
          path.relatedHashes.includes("base") &&
          path.path.includes("C"),
      ),
    ).toBe(true);
  });

  it("keeps refs on the row when multiple names point to one commit", () => {
    const layout = layoutGitGraph([
      {
        ...commit("head"),
        refs: [
          { name: "HEAD", kind: "head" },
          { name: "main", kind: "branch" },
          { name: "v1.0.0", kind: "tag" },
        ],
      },
    ]);

    expect(layout.rows[0]?.commit.refs.map((ref) => ref.name)).toEqual([
      "HEAD",
      "main",
      "v1.0.0",
    ]);
  });
});

describe("GitGraphPane", () => {
  it("renders graph rows, refs, and selected state in static markup", () => {
    const commits: GitGraphCommit[] = [
      {
        ...commit("f4d91c7", ["c18e2bb", "9a51d0a"]),
        refs: [
          { name: "HEAD", kind: "head" },
          { name: "feature/git-graph", kind: "branch" },
        ],
        subject:
          "Render an intentionally long commit subject that should truncate inside the row",
      },
      commit("c18e2bb", ["base"]),
      commit("9a51d0a", ["base"]),
      commit("base"),
    ];

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(GitGraphPane, {
          commits,
          hasMore: false,
          selectedCommitHash: "f4d91c7",
          onSelectCommit: vi.fn(),
          onRefresh: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("Git Graph");
    expect(html).toContain("Refresh Git Graph");
    expect(html).toContain("feature/git-graph");
    expect(html).toContain("Render an intentionally long commit subject");
    expect(html).toContain("bg-selected");
    expect(html).toContain("<svg");
  });

  it("keeps the graph column wide enough for the Graph header", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(GitGraphPane, {
          commits: [commit("head")],
          hasMore: false,
          selectedCommitHash: "head",
          onSelectCommit: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("grid-template-columns:minmax(56px, 44px) minmax(0, 1fr)");
    expect(html).toContain('width="56"');
  });
});
