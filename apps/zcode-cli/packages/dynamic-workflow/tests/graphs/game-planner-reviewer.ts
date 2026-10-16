// Planner-Reviewer 工作流: 为 3D HTML 小游戏生成经过评审的开发计划

interface TechStack {
  renderer: string;        // 渲染方案, 如 "Three.js (CDN)"
  libraries: string[];     // 依赖库及引入方式
  fileStructure: string[]; // 文件/模块结构
}

interface Milestone {
  name: string;
  scope: string[];
}

interface Risk {
  risk: string;
  mitigation: string;
}

interface GamePlan {
  title: string;
  genre: string;
  concept: string;
  coreLoop: string[];
  mechanics: string[];
  techStack: TechStack;
  controls: string[];
  progression: string[];
  artStyle: string;
  ui: string[];
  milestones: Milestone[];
  risks: Risk[];
  acceptanceCriteria: string[];
}

interface ReviewIssue {
  severity: "blocker" | "major" | "minor";
  area: string;
  description: string;
  suggestion: string;
}

interface ReviewVerdict {
  verdict: "approve" | "revise";
  score: number;
  strengths: string[];
  issues: ReviewIssue[];
  focusNext: string[];
}

const planner = agent("Planner", {
  system:
    "你是资深游戏策划兼前端 3D 工程师。为可直接在浏览器运行的 3D 小游戏制定开发计划。" +
    "硬约束: 纯前端、Three.js 走 CDN、单 HTML 文件优先、无构建步骤、目标 60fps。" +
    "计划必须具体、可执行、范围可控(1-3 天完成可玩原型), 并有明确的胜负条件与可测的验收标准。",
});

const reviewer = agent("Reviewer", {
  system:
    "你是严格的游戏计划评审员, 只依据给出的计划文本评审, 不臆测计划外内容。" +
    "评审维度: 1) 可行性(纯前端/无构建/浏览器可跑) 2) 玩法趣味与核心循环是否清晰 " +
    "3) 技术方案正确性 4) 范围控制 5) 验收标准可测性。" +
    "score>=8 且无 blocker 时才允许 approve, 否则必须 revise 并给出可执行的修改建议。",
});

const MAX_ROUNDS = 3;

log("第 1 轮: Planner 生成初版计划");
let plan: GamePlan = await planner.ask<GamePlan>(
  "请为一个 3D HTML 小游戏制定完整开发计划: 自选一个具体游戏概念并说明理由, " +
  "覆盖玩法核心循环、机制、技术栈(Three.js CDN)、操作、难度进程、美术风格、UI、" +
  "里程碑、风险与验收标准。输出 GamePlan。"
);

log("第 1 轮: Reviewer 评审");
let verdict: ReviewVerdict = await reviewer.ask<ReviewVerdict>(
  "请评审以下游戏开发计划:\n" + JSON.stringify(plan, null, 2)
);

let round = 1;
while (verdict.verdict !== "approve" && round < MAX_ROUNDS) {
  round = round + 1;
  log(
    "Reviewer 要求修订(得分 " + verdict.score + "/10, " +
    verdict.issues.length + " 个问题), 进入第 " + round + " 轮"
  );
  plan = await planner.ask<GamePlan>(
    "根据评审反馈修订计划, 重点解决 focusNext 与 blocker/major 问题, 保持 GamePlan 结构:\n" +
    "评审反馈:\n" + JSON.stringify(verdict, null, 2) +
    "\n\n当前计划:\n" + JSON.stringify(plan, null, 2)
  );
  verdict = await reviewer.ask<ReviewVerdict>(
    "请评审第 " + round + " 轮修订后的游戏开发计划:\n" + JSON.stringify(plan, null, 2)
  );
}

log("评审结束: " + verdict.verdict + ", 最终得分 " + verdict.score + "/10, 共 " + round + " 轮");
return { finalPlan: plan, finalReview: verdict, rounds: round };
