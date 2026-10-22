import { readdirSync } from "node:fs";
import { join } from "node:path";

// R3 远程 e2e 的 spec 清单单点事实：服务器全量队列（harness/remote/run-all-remote.sh）与覆盖
// 审计都从这里取名单。缺陷原因：2026-09-14 首轮服务器全量各自手写 case 列表，62 个远程 case 只
// 排进 49 个，漏掉的 13 个既不在结果台账里也不会报错，等于覆盖率静默缩水。

/** pending / formal 里按命名规则即可判定为远程连接 case 的前缀。 */
const REMOTE_SPEC_PREFIXES = [
  "conversation-session-r3-",
  "conversation-session-rdux-",
  "conversation-session-ssh-remote-",
  "conversation-session-remote-",
  "conversation-session-plugin-remote-",
];

/** 命名不带上述前缀、但确实覆盖远程连接行为的 spec（相对 test/e2e）。 */
const EXTRA_REMOTE_SPECS = [
  // 项目/设置/聊天命名没有远程前缀；候选也必须进入远程全量回归分母。
  "conversation-session/manual-review/pending/conversation-session-settings-connection-completion.test.ts",
  "conversation-session/manual-review/pending/conversation-session-project-device-selection.test.ts",
  "conversation-session/manual-review/pending/conversation-session-project-settings-return.test.ts",
  "conversation-session/manual-review/pending/conversation-session-existing-remote-project.test.ts",
  "conversation-session/manual-review/pending/conversation-session-chat-device-return.test.ts",
  // 聊天目录的三个分派都使用真实 SSH；chat 前缀不会被上面的远程命名规则自动发现。
  "conversation-session/manual-review/pending/conversation-session-chat-remote-folder.test.ts",
  "conversation-session/manual-review/pending/conversation-session-chat-remote-folder-create.test.ts",
  "conversation-session/manual-review/pending/conversation-session-chat-remote-project-choice.test.ts",
  "conversation-session/manual-review/pending/conversation-session-background-connection.test.ts",
  "conversation-session/manual-review/pending/conversation-session-ssh-disconnect-experience.test.ts",
  // 文件名不含 ssh-remote 前缀，曾同时漏出清单和队列；显式登记以纳入覆盖门禁。
  "conversation-session/manual-review/pending/conversation-session-ssh-provisioning-failure.test.ts",
  // SSH trusted attachment 组合远端 Rows/File 与本地 JWT/API。
  "conversation-session/manual-review/pending/conversation-session-share-ssh-artifact.test.ts",
  // BOT-E2E-RW-01：远程 workspace 断开时拒绝投递（synthetic fixture，不建真实连接）。
  "bots/bot-remote-disconnected.test.ts",
  "bots/manual-review/pending/bot-r3-workspace-identity.test.ts",
  "bots/bot-runtime-authority.test.ts",
  "conversation-session/manual-review/pending/conversation-session-rpn-project-navigation.test.ts",
  // 内含 MP-UI-05-remote：远程 workspace 激活时也不显示配置同步入口。
  "settings/settings-ui-polish.test.ts",
];

/**
 * 属于远程 spec、但全量队列现有档位无法构造其 fixture 的例外（相对 test/e2e）。
 * 这些 spec 仍算进清单（改名/删除会被察觉），只是不要求排进 run-all-remote.sh；
 * 每一条必须写明队列缺什么，补齐 harness 后即从这里移除并入队。
 */
// 根因：队列早已为每条 case 新建干净用户，旧例外却仍追加同名结果，覆盖了真正的安装进度结果。
// 三屏向导由队列指定 home 为首目录，不再依赖人工 fixture。
export const DEDICATED_FIXTURE_SPECS = [];

/** 扫描 test/e2e 时只看这几个目录，避免把 fixtures / helpers 里的同名文件算进来。 */
const SCANNED_DIRECTORIES = ["conversation-session", "conversation-session/manual-review/pending"];

function listTestFiles(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function isRemoteSpecName(name) {
  return REMOTE_SPEC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * 列出全部远程连接相关 spec（相对 `test/e2e` 的 POSIX 路径，已排序去重）。
 */
export function listRemoteE2ESpecs({ e2eRoot }) {
  const found = new Set(EXTRA_REMOTE_SPECS);
  for (const directory of SCANNED_DIRECTORIES) {
    for (const name of listTestFiles(join(e2eRoot, directory))) {
      if (isRemoteSpecName(name)) {
        found.add(`${directory}/${name}`);
      }
    }
  }
  return [...found].sort();
}

/**
 * 从服务器队列脚本文本里提取被排进队列的 spec。队列使用 `$PENDING/<name>`、`$FORMAL/<name>`
 * 与完整 `test/e2e/...` 三种写法，这里都归一成相对 test/e2e 的路径。
 */
export function extractQueuedSpecs(queueSource) {
  const queued = new Set();
  for (const match of queueSource.matchAll(/\$PENDING\/([\w.-]+\.test\.ts)/gu)) {
    queued.add(`conversation-session/manual-review/pending/${match[1]}`);
  }
  for (const match of queueSource.matchAll(/\$FORMAL\/([\w.-]+\.test\.ts)/gu)) {
    queued.add(`conversation-session/${match[1]}`);
  }
  for (const match of queueSource.matchAll(/test\/e2e\/([\w./-]+\.test\.ts)/gu)) {
    queued.add(match[1]);
  }
  return [...queued].sort();
}

/**
 * 覆盖差集：`missing` 是清单里有、队列没排的（登记在 dedicatedFixtureSpecs 的例外不算缺）；
 * `unknown` 是队列排了、清单不认的（多为改名残留）；`staleDedicated` 是例外名单里
 * 已不在清单或已经排进队列的条目，说明例外登记过期需要清理。
 */
export function diffRemoteSpecCoverage({
  specs,
  queueSource,
  dedicatedFixtureSpecs = DEDICATED_FIXTURE_SPECS,
}) {
  const queued = new Set(extractQueuedSpecs(queueSource));
  const inventory = new Set(specs);
  const dedicated = new Set(dedicatedFixtureSpecs);
  return {
    missing: specs.filter((spec) => !queued.has(spec) && !dedicated.has(spec)),
    unknown: [...queued].filter((spec) => !inventory.has(spec)).sort(),
    staleDedicated: dedicatedFixtureSpecs
      .filter((spec) => !inventory.has(spec) || queued.has(spec))
      .sort(),
  };
}
