import finderIcon from "@/onboarding/assets/finder.png";
import terminalIcon from "@/onboarding/assets/terminal.png";
import feishuIcon from "@/onboarding/assets/feishu.png";
import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

type RecommendedPrompt = DraftSuggestedPromptItem & {
  category: "development" | "office" | "finance" | "utility";
};

export const officeSuggestedPrompts: RecommendedPrompt[] = [
  {
    id: "official-0",
    category: "development",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/github/icon.png",
    label: {
      cn: "帮我看看这个仓库最近的改动，有哪些值得关注",
      en: "Review recent changes in this repository and highlight what matters.",
    },
    prompt: {
      cn: "帮我看看这个仓库最近的改动，有哪些值得关注",
      en: "Review recent changes in this repository and highlight what matters.",
    },
    plugin: {
      stableId: "github@zcode-plugins-official",
      label: {
        cn: "GitHub",
        en: "github",
      },
    },
  },
  {
    id: "official-1",
    category: "development",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/gitlab/icon.png",
    label: {
      cn: "帮我检查当前分支的改动，找出提交 MR 前需要修复的问题",
      en: "Review this branch and find issues to fix before submitting a merge request.",
    },
    prompt: {
      cn: "帮我检查当前分支的改动，找出提交 MR 前需要修复的问题",
      en: "Review this branch and find issues to fix before submitting a merge request.",
    },
    plugin: {
      stableId: "gitlab@zcode-plugins-official",
      label: {
        cn: "GitLab",
        en: "gitlab",
      },
    },
  },
  {
    id: "official-2",
    category: "development",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/mimosa/icon.png",
    label: {
      cn: "帮我扫描这个项目的安全隐患，优先修复高风险问题",
      en: "Scan this project for security issues and prioritize high-risk fixes.",
    },
    prompt: {
      cn: "帮我扫描这个项目的安全隐患，优先修复高风险问题",
      en: "Scan this project for security issues and prioritize high-risk fixes.",
    },
    plugin: {
      stableId: "mimosa@zcode-plugins-official",
      label: {
        cn: "代码安全防护",
        en: "mimosa",
      },
    },
  },
  {
    id: "official-3",
    category: "development",
    iconUrl: "https://docs.cloudbase.net/en/img/favicon.png",
    label: {
      cn: "帮我做一个带登录和数据存储的待办小程序",
      en: "Build a to-do mini program with sign-in and data storage.",
    },
    prompt: {
      cn: "帮我做一个带登录和数据存储的待办小程序",
      en: "Build a to-do mini program with sign-in and data storage.",
    },
    plugin: {
      stableId: "cloudbase-skills@zcode-plugins-official",
      label: {
        cn: "CloudBase",
        en: "cloudbase-skills",
      },
    },
  },
  {
    id: "official-4",
    category: "development",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/video2code/icon.png",
    label: {
      cn: "把我提供的网页录屏还原成一个可交互的页面",
      en: "Recreate my website recording as an interactive page.",
    },
    prompt: {
      cn: "把我提供的网页录屏还原成一个可交互的页面",
      en: "Recreate my website recording as an interactive page.",
    },
    plugin: {
      stableId: "video2code@zcode-plugins-official",
      label: {
        cn: "Video2Code",
        en: "video2code",
      },
    },
  },
  {
    id: "official-5",
    category: "development",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/browser-use/icon.png",
    label: {
      cn: "帮我检查本地网页，找出布局和交互上的问题",
      en: "Check my local website for layout and interaction issues.",
    },
    prompt: {
      cn: "帮我检查本地网页，找出布局和交互上的问题",
      en: "Check my local website for layout and interaction issues.",
    },
    plugin: {
      stableId: "browser-use@zcode-plugins-official",
      label: {
        cn: "浏览器操作",
        en: "browser-use",
      },
    },
  },
  {
    id: "official-6",
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/lark-cli/icon.png",
    label: {
      cn: "帮我整理昨天的飞书工作记录，列出今天需要跟进的事项",
      en: "Review yesterday’s Lark work records and list today’s follow-ups.",
    },
    prompt: {
      cn: "帮我整理昨天的飞书工作记录，列出今天需要跟进的事项",
      en: "Review yesterday’s Lark work records and list today’s follow-ups.",
    },
    plugin: {
      stableId: "lark-cli@zcode-plugins-official",
      label: {
        cn: "飞书 CLI",
        en: "lark-cli",
      },
    },
  },
  {
    id: "official-7",
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/tencent-meeting-cli/icon.png",
    label: {
      cn: "帮我整理最近一次会议的参会情况，生成一份简报",
      en: "Summarize attendance at my most recent Tencent Meeting.",
    },
    prompt: {
      cn: "帮我整理最近一次会议的参会情况，生成一份简报",
      en: "Summarize attendance at my most recent Tencent Meeting.",
    },
    plugin: {
      stableId: "tencent-meeting-cli@zcode-plugins-official",
      label: {
        cn: "腾讯会议 CLI",
        en: "tencent-meeting-cli",
      },
    },
  },
  {
    id: "official-8",
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/wecom-cli/icon.png",
    label: {
      cn: "帮我查看今天的日程和待办，安排一下工作顺序",
      en: "Review today’s WeCom calendar and to-dos and organize my work.",
    },
    prompt: {
      cn: "帮我查看今天的日程和待办，安排一下工作顺序",
      en: "Review today’s WeCom calendar and to-dos and organize my work.",
    },
    plugin: {
      stableId: "wecom-cli@zcode-plugins-official",
      label: {
        cn: "企业微信 CLI",
        en: "wecom-cli",
      },
    },
  },
  {
    id: "official-9",
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/document-skills/icon.png",
    label: {
      cn: "把我的笔记整理成一份排版清晰的 Word 文档",
      en: "Turn my notes into a clearly formatted Word document.",
    },
    prompt: {
      cn: "把我的笔记整理成一份排版清晰的 Word 文档",
      en: "Turn my notes into a clearly formatted Word document.",
    },
    plugin: {
      stableId: "documents@zcode-plugins-official",
      label: {
        cn: "Word文档",
        en: "documents",
      },
    },
  },
  {
    id: "official-10",
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/document-skills/icon.png",
    label: {
      cn: "分析这份 Excel，找出关键趋势并生成图表",
      en: "Analyze this Excel file, identify key trends and create charts.",
    },
    prompt: {
      cn: "分析这份 Excel，找出关键趋势并生成图表",
      en: "Analyze this Excel file, identify key trends and create charts.",
    },
    plugin: {
      stableId: "spreadsheets@zcode-plugins-official",
      label: {
        cn: "电子表格",
        en: "spreadsheets",
      },
    },
  },
  {
    id: "official-11",
    category: "office",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/video-agent/icon.png",
    label: {
      cn: "帮我把这段长视频剪成一分钟精华版，加上字幕",
      en: "Edit this long video into a one-minute highlight reel with subtitles.",
    },
    prompt: {
      cn: "帮我把这段长视频剪成一分钟精华版，加上字幕",
      en: "Edit this long video into a one-minute highlight reel with subtitles.",
    },
    plugin: {
      stableId: "video-agent-kit@zcode-plugins-official",
      label: {
        cn: "Video Agent Kit",
        en: "video-agent-kit",
      },
    },
  },
  {
    id: "official-12",
    category: "finance",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/corporate-due-diligence/icon.png",
    label: {
      cn: "帮我对这家公司做一份尽调，重点看看关联关系和经营风险",
      en: "Perform due diligence on this company, focusing on relationships and business risks.",
    },
    prompt: {
      cn: "帮我对这家公司做一份尽调，重点看看关联关系和经营风险",
      en: "Perform due diligence on this company, focusing on relationships and business risks.",
    },
    plugin: {
      stableId: "vet-companies@zcode-plugins-official",
      label: {
        cn: "企业尽调",
        en: "vet-companies",
      },
    },
  },
  {
    id: "official-13",
    category: "finance",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/business-analysis/icon.png",
    label: {
      cn: "根据这份收支数据，做一份未来 13 周的现金流预测",
      en: "Use this income and expense data to forecast cash flow for the next 13 weeks.",
    },
    prompt: {
      cn: "根据这份收支数据，做一份未来 13 周的现金流预测",
      en: "Use this income and expense data to forecast cash flow for the next 13 weeks.",
    },
    plugin: {
      stableId: "run-fpa@zcode-plugins-official",
      label: {
        cn: "经营分析",
        en: "run-fpa",
      },
    },
  },
  {
    id: "official-14",
    category: "finance",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/portfolio-tracking/icon.png",
    label: {
      cn: "帮我整理自选股今天的表现，以及值得关注的公告",
      en: "Summarize today’s watchlist performance and notable announcements.",
    },
    prompt: {
      cn: "帮我整理自选股今天的表现，以及值得关注的公告",
      en: "Summarize today’s watchlist performance and notable announcements.",
    },
    plugin: {
      stableId: "watch-positions@zcode-plugins-official",
      label: {
        cn: "持仓跟踪",
        en: "watch-positions",
      },
    },
  },
  {
    id: "official-15",
    category: "utility",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/skill-creator/icon.png",
    label: {
      cn: "把我经常重复的工作流程做成一个可复用的技能",
      en: "Turn my recurring workflow into a reusable skill.",
    },
    prompt: {
      cn: "把我经常重复的工作流程做成一个可复用的技能",
      en: "Turn my recurring workflow into a reusable skill.",
    },
    plugin: {
      stableId: "skill-creator@zcode-plugins-official",
      label: {
        cn: "技能创建器",
        en: "skill-creator",
      },
    },
  },
  {
    id: "official-16",
    category: "utility",
    iconUrl: "https://cdn-zcode.z.ai/zcode/official-plugin/assets/zcode-guide/icon.png",
    label: {
      cn: "帮我检查当前的 ZCode 配置，看看有哪些可以调整",
      en: "Review my ZCode configuration and suggest useful adjustments.",
    },
    prompt: {
      cn: "帮我检查当前的 ZCode 配置，看看有哪些可以调整",
      en: "Review my ZCode configuration and suggest useful adjustments.",
    },
    plugin: {
      stableId: "zcode-guide@zcode-plugins-official",
      label: {
        cn: "ZCode 使用指南",
        en: "zcode-guide",
      },
    },
  },
];

export function getRecommendedPromptPool(
  isOfficeMode: boolean,
  occupation?: string | null,
): DraftSuggestedPromptItem[] {
  const preferred = occupation === "finance" ? "finance" : isOfficeMode ? "office" : "development";
  const eligible = officeSuggestedPrompts.filter(
    (item) => item.category !== "finance" || occupation === "finance",
  );
  return [
    ...eligible.filter((item) => item.category === preferred),
    ...eligible.filter((item) => item.category !== preferred),
  ];
}

export const defaultSuggestedPrompts: DraftSuggestedPromptItem[] = [
  {
    id: "office-organize",
    iconUrl: finderIcon,
    label: {
      cn: "帮我看看我现在电脑上什么文件占用了主要空间？",
      en: "Help me see which files are taking up the most space on my computer.",
    },
    prompt: {
      cn: "帮我看看我现在电脑上什么文件占用了主要空间？",
      en: "Help me see which files are taking up the most space on my computer.",
    },
  },
  {
    id: "office-clean",
    iconUrl: terminalIcon,
    label: {
      cn: "帮我使用 Mole CLI 清理下电脑的冗余文件",
      en: "Use Mole CLI to clean redundant files on my computer.",
    },
    prompt: {
      cn: "帮我使用 Mole CLI 清理下电脑的冗余文件",
      en: "Use Mole CLI to clean redundant files on my computer.",
    },
  },
  {
    id: "office-review",
    iconUrl: feishuIcon,
    label: {
      cn: "帮我用飞书 CLI 获取下我昨天的工作情况，梳理今日工作待办",
      en: "Use Feishu CLI to review my work from yesterday and organize today’s to-dos.",
    },
    prompt: {
      cn: "帮我用飞书 CLI 获取下我昨天的工作情况，梳理今日工作待办",
      en: "Use Feishu CLI to review my work from yesterday and organize today’s to-dos.",
    },
  },
];
