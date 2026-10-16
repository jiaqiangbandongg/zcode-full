import type {
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketStatus,
  FeedbackTicketType,
} from "@zcode/shared";
import type { ComponentType, SVGProps } from "react";
import {
  FeedbackBugIcon,
  FeedbackIdeaIcon,
  FeedbackPerformanceIcon,
  FeedbackQuestionIcon,
} from "@/feedback/feedbackIcons.js";

interface TypeMeta {
  value: FeedbackTicketType;
  label: string;
  description: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** 选中时图标颜色 */
  iconText: string;
}

type MessageFormatter = (
  descriptor: { id: string },
  values?: Record<string, string>,
) => string;

export const FEEDBACK_TYPE_META: TypeMeta[] = [
  {
    value: "bug",
    label: "遇到 Bug",
    description: "报错、崩溃、功能不符合预期",
    Icon: FeedbackBugIcon,
    iconText: "text-rose-500 dark:text-rose-400",
  },
  {
    value: "usage",
    label: "不会使用",
    description: "操作不清楚、配置不确定",
    Icon: FeedbackQuestionIcon,
    iconText: "text-sky-500 dark:text-sky-400",
  },
  {
    value: "feature",
    label: "想提建议",
    description: "希望支持的新能力或体验优化",
    Icon: FeedbackIdeaIcon,
    iconText: "text-amber-500 dark:text-amber-400",
  },
  {
    value: "performance",
    label: "运行很慢",
    description: "卡顿、响应慢、资源占用异常",
    Icon: FeedbackPerformanceIcon,
    iconText: "text-violet-500 dark:text-violet-400",
  },
];
export const SEVERITY_META: {
  value: FeedbackTicketSeverity;
  label: string;
  hint: string;
  dot: string;
}[] = [
  { value: "P1-高", label: "完全用不了", hint: "P1", dot: "bg-rose-500" },
  { value: "P2-中", label: "影响使用", hint: "P2", dot: "bg-amber-500" },
  { value: "P3-低", label: "小问题/建议", hint: "P3", dot: "bg-emerald-500" },
];

interface StatusMeta {
  className: string;
  dot: string;
}

export const STATUS_META: Record<FeedbackTicketStatus, StatusMeta> = {
  已提交: {
    className: "text-amber-700 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  信息不足: {
    className: "text-orange-700 dark:text-orange-300",
    dot: "bg-orange-500",
  },
  已采纳: {
    className: "text-sky-700 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  答复关闭: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  // 公开反馈接口会把历史「答复关闭」归一为「已归档」返回。
  // 客户端必须同时识别两种终态，否则我的反馈列表渲染状态标记时会拿不到 meta 而崩溃。
  已归档: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  已拒绝: {
    className: "text-foreground-subtle",
    dot: "bg-foreground-subtlest",
  },
  开发中: {
    className: "text-violet-700 dark:text-violet-300",
    dot: "bg-violet-500",
  },
  已解决: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  已上线: {
    className: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
};

export const SEVERITY_BADGE: Record<
  FeedbackTicketSeverity,
  { label: string; className: string }
> = {
  "P1-高": {
    label: "P1",
    className: "text-rose-600 dark:text-rose-400 border-rose-500/40",
  },
  "P2-中": {
    label: "P2",
    className: "text-amber-600 dark:text-amber-400 border-amber-500/40",
  },
  "P3-低": {
    label: "P3",
    className: "text-emerald-600 dark:text-emerald-400 border-emerald-500/40",
  },
};

export const FEEDBACK_MODULE_MESSAGE_IDS: Record<FeedbackTicketModule, string> = {
  "Plugin / MCP": "feedback.module.pluginMcp",
  Agent任务执行失败: "feedback.module.agentTaskFailed",
  "模型配置 / API Key": "feedback.module.modelConfigApiKey",
  模型调用报错: "feedback.module.modelCallError",
  "权限 / 配置保存": "feedback.module.permissionConfigSave",
  SSH连接失败: "feedback.module.sshConnectionFailed",
  WSL连接失败: "feedback.module.wslConnectionFailed",
  "UI布局 / 交互": "feedback.module.uiLayoutInteraction",
  "模型响应慢 / 额度": "feedback.module.modelSlowQuota",
  "崩溃 / Internal Error": "feedback.module.crashInternalError",
  "文档 / 使用咨询": "feedback.module.docsUsage",
  其它: "feedback.module.other",
};

export const FEEDBACK_STATUS_MESSAGE_IDS: Record<FeedbackTicketStatus, string> = {
  已提交: "feedback.status.pendingReview",
  信息不足: "feedback.status.needInfo",
  已采纳: "feedback.status.accepted",
  答复关闭: "feedback.status.closedByReply",
  // 后端 closed 仍归一为「已归档」兼容值，但不能把接口内部命名直接暴露给用户。
  // 这里映射到 completed 展示文案，让“我的反馈”列表和详情统一显示为「已完成」。
  已归档: "feedback.status.completed",
  已拒绝: "feedback.status.rejected",
  开发中: "feedback.status.inDevelopment",
  已解决: "feedback.status.resolved",
  已上线: "feedback.status.released",
};

export function formatFeedbackModuleLabel(
  module: FeedbackTicketModule,
  formatMessage: MessageFormatter,
) {
  return formatMessage({ id: FEEDBACK_MODULE_MESSAGE_IDS[module] });
}

export function formatFeedbackStatusLabel(
  status: FeedbackTicketStatus,
  formatMessage: MessageFormatter,
) {
  return formatMessage({ id: FEEDBACK_STATUS_MESSAGE_IDS[status] });
}
