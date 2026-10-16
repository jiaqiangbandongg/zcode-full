interface ImplUpdate {
  /** 本轮改动过的文件路径 */
  changed: string[];
  /** 改动说明：这一版怎么处理上一轮的反例 */
  notes: string;
  /** 交付前 lake build 是否自检通过 */
  buildOk: boolean;
}

interface Verdict {
  pass: boolean;
  /** pass 时：证明写在哪个文件里 */
  proofPath?: string;
  /** 证伪时：能复现失败的具体反例输入 */
  counterExamples?: string[];
  /** 判定理由，作为下一轮 Programmer 的输入 */
  reason: string;
}

const IMPL_PATH = "lean/Compress.lean";
const PROOF_PATH = "lean/CompressProof.lean";
const THEOREM = "∀ s, decompress (compress s) = s";

const programmer = agent("Programmer", {
  system:
    `你是 Lean 4 工程师。实现写进 ${IMPL_PATH}，交付前必须用 lake build 自检。` +
    "交付物是文件本身，消息里只说改了什么，不要把源码贴回来。",
});

const prover = agent("Prover", {
  system:
    `你是 Lean 4 形式化验证专家。读 ${IMPL_PATH}，把证明写进 ${PROOF_PATH}，用 lake build 验证。` +
    "证不出来就是 pass=false，并给出具体反例；不要用 sorry 蒙混过关。",
});

const MAX_ROUNDS = 10;

let impl = await programmer.ask<ImplUpdate>(
  `在 ${IMPL_PATH} 中实现 compress / decompress，目标是能证明 ${THEOREM}。`,
);
let verdict = await prover.ask<Verdict>(
  `请证明或证伪 ${THEOREM}。\n实现: ${impl.changed.join(", ")}\n` +
    `作者说明: ${impl.notes}\n自检: lake build ${impl.buildOk ? "通过" : "未通过"}`,
);

let round = 1;
while (!verdict.pass && round < MAX_ROUNDS) {
  round = round + 1;
  log(`第 ${round} 轮: ${verdict.counterExamples?.length ?? 0} 个反例`);
  impl = await programmer.ask<ImplUpdate>(
    `上一版未通过验证。\n理由: ${verdict.reason}\n` +
      `反例: ${JSON.stringify(verdict.counterExamples ?? [])}\n` +
      `请直接改 ${IMPL_PATH}（失败的证明尝试见 ${PROOF_PATH}），改完 lake build 自检。`,
  );
  verdict = await prover.ask<Verdict>(
    `实现已更新（${impl.notes}）。请重新证明或证伪 ${THEOREM}。`,
  );
}

return {
  proved: verdict.pass,
  rounds: round,
  implPath: IMPL_PATH,
  proofPath: verdict.proofPath,
  verdict,
};
