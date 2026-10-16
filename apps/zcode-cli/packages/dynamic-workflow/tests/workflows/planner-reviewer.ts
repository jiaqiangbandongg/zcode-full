// 测试语料，**不是**作者范例：末尾 `findings.findings.map((f) => agent("judge")…)` 里那个静态
// 名是**故意留着**的，别把它「修好」。这段脚本运行期会撞 DuplicateActorName、编译期拿一条
// 9006（docs/execution-engine.md「Amend-resume」），所以它不可提交——
// 而语料要的恰恰是这个形状：本文件与 tests/graphs/planner-reviewer.ts 是同一段源码的两份，
// 后者的图快照（tests/graphs/expected/planner-reviewer*.txt）钉住分析器对「fan-out 里的具名
// actor」的全部产物（`ActorNode.family`、actor 标签、因果图）。改成
// `` agent(`judge-${f.testId}`) `` 会把两边一起搬到 `ActorSite.namePattern` 那条**另一条**
// 代码路径上，等于删掉这份覆盖；语料对 9006 的豁免见 tests/helpers/analysis-corpus.ts。
// （注释只加在这一份：graphs 那份的快照记录行号，加一行注释就是一次假 diff。）
// 要照抄的作者范例在 packages/bundled-skills/skills/dynamic-workflows/。
interface Flaky {
  findings: {
    testId: string;
    /** 0-1, how confident the scan is */
    confidence: number;
  }[];
}

interface Review {
  approved: boolean;
  feedback: string;
}

const findings = await agent("scanner").ask<Flaky>("Find flaky tests");
log(`found ${findings.findings.length} findings`);

const planner = agent("planner", "You plan fixes...");
const reviewer = agent("reviewer", { system: "You critique plans..." });

let feedback = "none";
for (let round = 0; round < 5; round++) {
  const plan = await planner.ask<string>(`Plan fixes. Feedback: ${feedback}`);
  const review = await reviewer.ask<Review>(`Critique: ${plan}`);
  if (review.approved) return plan;
  feedback = review.feedback;
}

const verdicts = await Promise.all(
  findings.findings.map((f) => agent("judge").ask<Review>(`Judge: ${f.testId}`)),
);
return verdicts.filter((v) => v.approved).length;
