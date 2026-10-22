import type { MigrationResult } from "@zcode/shared/sqlite-migrations";

export interface AgentStorageMigrationInput {
  /** 复用已有 Agent executable resolver 的结果；协议命令前的 runtime 参数原样保留。 */
  command: {
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  env?: NodeJS.ProcessEnv;
}
export interface StartupStorageContract {
  /** 等待同一 CLI 迁移结束并关闭连接；非零退出/非法结果拒绝，不启动业务 runtime。 */
  migrateAgent(input: AgentStorageMigrationInput): Promise<MigrationResult>;
}
