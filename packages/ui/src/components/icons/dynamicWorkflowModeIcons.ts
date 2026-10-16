import { createLucideIcon, type IconNode } from "lucide-react";

// 动态工作流三个模式的图标（docs/dynamic-workflow/launch.md「The user's choice」）：都从 Lucide
// Workflow 的两个方框与连线出发，用 Lucide 渲染以继承主题前景色、全局线宽与层级透明度。
const WORKFLOW_FIRST_BOX_AND_LINK: IconNode = [
  ["rect", { width: "8", height: "8", x: "3", y: "3", rx: "2", key: "first" }],
  ["path", { d: "M7 11v4a2 2 0 0 0 2 2h4", key: "link" }],
];
const WORKFLOW_SECOND_BOX: IconNode[number] = [
  "rect",
  { width: "8", height: "8", x: "13", y: "13", rx: "2", key: "second" },
];

/** 始终开启：完整的工作流。 */
export const DynamicWorkflowAlwaysOnIcon = createLucideIcon("DynamicWorkflowAlwaysOn", [
  ...WORKFLOW_FIRST_BOX_AND_LINK,
  WORKFLOW_SECOND_BOX,
]);

/** 通过命令启用：第二个方框虚线，表示要等命令才落地。 */
export const DynamicWorkflowOnCommandIcon = createLucideIcon("DynamicWorkflowOnCommand", [
  ...WORKFLOW_FIRST_BOX_AND_LINK,
  [
    "rect",
    { width: "8", height: "8", x: "13", y: "13", rx: "2", strokeDasharray: "2 2", key: "second" },
  ],
]);

/** 关闭：工作流加一道斜线。 */
export const DynamicWorkflowOffIcon = createLucideIcon("DynamicWorkflowOff", [
  ...WORKFLOW_FIRST_BOX_AND_LINK,
  WORKFLOW_SECOND_BOX,
  ["path", { d: "M4 20 20 4", key: "slash" }],
]);
