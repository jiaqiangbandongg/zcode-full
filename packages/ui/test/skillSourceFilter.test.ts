import { describe, expect, it } from "vitest";
import { filterSkillsForProvider, resolveSkillSourceType } from "@/lib/skillSourceFilter.js";

const demoSkills = [
  {
    id: "skill-claude",
    path: "/tmp/workspace/.claude/skills/claude-only/SKILL.md",
  },
  {
    id: "skill-agents",
    path: "/tmp/workspace/.agents/skills/agents-only/SKILL.md",
  },
  {
    id: "skill-glm-deprecated",
    path: "/tmp/workspace/.zcode/cli/skills/glm-only/SKILL.md",
  },
  {
    id: "skill-glm-by-path",
    path: "/tmp/workspace/.zcode/skills/glm-only/SKILL.md",
  },
  {
    id: "glm:workspace:zcode-common:abc123",
    path: "/tmp/workspace/.zcode/skills/common/SKILL.md",
  },
  {
    id: "claude:workspace:zcode-common:abc123",
    path: "/tmp/workspace/.zcode/skills/common-from-legacy-list/SKILL.md",
  },
  {
    id: "glm:user:mirrored:abc123",
    path: "/tmp/workspace/.agents/skills/mirrored/SKILL.md",
  },
  {
    id: "skill-plugin-by-scope",
    path: "/tmp/home/.zcode/cli/plugins/cache/zcode-plugins-official/document-skills/0.1.0/skills/pdf/SKILL.md",
    scope: "plugin",
  },
  {
    id: "skill-plugin-by-path",
    path: "/tmp/home/.zcode/cli/plugins/cache/zcode-plugins-official/document-skills/0.1.0/skills/docx/SKILL.md",
  },
];

describe("skillSourceFilter", () => {
  it("把 .zcode/skills 和官方 plugin cache 识别为 ZCode Agent 技能来源", () => {
    expect(resolveSkillSourceType("/tmp/workspace/.zcode/skills/my-skill/SKILL.md")).toBe(
      "glm",
    );
    expect(
      resolveSkillSourceType(
        "/tmp/home/.zcode/cli/plugins/cache/zcode-plugins-official/document-skills/0.1.0/skills/pdf/SKILL.md",
      ),
    ).toBe("glm");
    expect(resolveSkillSourceType("/tmp/workspace/.zcode/cli/skills/my-skill/SKILL.md")).toBe(
      "unknown",
    );
    expect(resolveSkillSourceType("/tmp/workspace/.agents/skills/my-skill/SKILL.md")).toBe(
      "unknown",
    );
  });

  it("provider 参数只作兼容输入，过滤结果始终保留 ZCode Agent 技能", () => {
    const expectedIds = [
      "skill-glm-by-path",
      "glm:workspace:zcode-common:abc123",
      "claude:workspace:zcode-common:abc123",
      "glm:user:mirrored:abc123",
      "skill-plugin-by-scope",
      "skill-plugin-by-path",
    ];

    expect(filterSkillsForProvider(demoSkills, "glm").map((skill) => skill.id)).toEqual(
      expectedIds,
    );
    expect(filterSkillsForProvider(demoSkills, "claude").map((skill) => skill.id)).toEqual(
      expectedIds,
    );
    expect(filterSkillsForProvider(demoSkills, "codex").map((skill) => skill.id)).toEqual(
      expectedIds,
    );
  });
});
