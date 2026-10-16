import { createRoot } from "react-dom/client";
import { useState } from "react";
import { WorkflowAgentFace } from "@/components/workflow-timeline/WorkflowAgentFace.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";

function Preview() {
  const [status, setStatus] = useState<StepRunStatus>("running");
  return (
    <main>
      <h1>工作流头像 · 自然随机眼神</h1>
      <p>切换状态观察眼神；每张脸独立随机。下排为最小 20px 尺寸。</p>
      <nav>
        {(["running", "pending", "failed", "done"] as const).map((value, i) => (
          <button
            key={value}
            onClick={() => setStatus(value)}
            aria-pressed={status === value}
            data-status={value}
          >
            {["运行", "等待", "失败", "成功"][i]}
          </button>
        ))}
      </nav>
      {[48, 20].map((size) => (
        <section key={size} style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 28 }}>
          {Array.from({ length: 9 }, (_, i) => (
            <span key={i} style={{ width: size, height: size, display: "inline-block" }}>
              <WorkflowAgentFace avatarIndex={i} name={`Agent ${i + 1}`} status={status} />
            </span>
          ))}
        </section>
      ))}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
