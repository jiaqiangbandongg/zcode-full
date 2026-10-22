import type { ConnectConfig } from "ssh2";
import type { PublicZCodeErrorCode } from "@zcode/shared";

export const SSH_READY_TIMEOUT_MS = 60_000;
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
export const SSH_KEEPALIVE_COUNT_MAX = 3;

interface SSHConnectConfigInput {
  host: string;
  port?: number;
  username: string;
  privateKey?: string | Buffer;
  passphrase?: string;
  password?: string;
  agent?: string;
}

function isMissingPrivateKeyPassphraseMessage(message: string): boolean {
  return /encrypted .*private .*key detected, but no passphrase given/i.test(message);
}

function isInvalidPrivateKeyPassphraseMessage(message: string): boolean {
  return /(bad passphrase|key integrity check failed|unable to authenticate data)/i.test(message);
}

export function buildSSHConnectConfig(input: SSHConnectConfigInput): ConnectConfig {
  const hasPassword = typeof input.password === "string" && input.password.length > 0;

  // 密码登录场景里如果无条件带上 SSH_AUTH_SOCK，ssh2 会先走 agent 公钥尝试。
  // 某些主机 MaxAuthTries 很小，公钥阶段就会把认证次数耗尽，导致正确密码也无法进入认证。
  // 这里改成“显式传入 agent 才启用”；否则密码模式默认禁用隐式 agent。
  const resolvedAgent = input.agent ?? (hasPassword ? undefined : process.env["SSH_AUTH_SOCK"]);

  return {
    host: input.host,
    port: input.port ?? 22,
    username: input.username,
    privateKey: input.privateKey,
    passphrase: input.passphrase,
    password: hasPassword ? input.password : undefined,
    agent: resolvedAgent,
    // ssh2 默认 readyTimeout 是 20s，公网弱网或服务端抖动时容易误判超时。
    // 这里显式放宽连接握手超时，既给真实慢连接机会，也让错误归一化能和实际配置保持一致。
    readyTimeout: SSH_READY_TIMEOUT_MS,
    // SSH 项目空闲后如果被 NAT、防火墙或服务端静默断开，stdio channel 不一定会立刻 close。
    // 启用 SSH-level keepalive，让 ssh2 在连续无响应后主动触发 error/close，避免 UI 任务长期卡在 loading。
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    // 一些 SSH 服务端只开启 keyboard-interactive（challenge-response）而关闭 plain password。
    // 开启 tryKeyboard + 交互回调后，同一份密码可以覆盖这类主机，避免“命令行可登录、应用里认证失败”。
    tryKeyboard: hasPassword,
  };
}

export function createKeyboardInteractiveResponder(password?: string) {
  return (
    _name: string,
    _instructions: string,
    _lang: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (responses: string[]) => void,
  ) => {
    if (!password || prompts.length === 0) {
      finish([]);
      return;
    }

    finish(prompts.map(() => password));
  };
}

export function normalizeSSHConnectError(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-authentication"
  ) {
    return authenticationError("SSH 认证失败：请检查用户名、密码或私钥配置", error);
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "level" in error &&
    (error as { level?: string }).level === "client-timeout"
  ) {
    return new Error(
      `SSH 连接握手超时：未能在 ${SSH_READY_TIMEOUT_MS / 1000} 秒内建立 SSH 会话，请检查网络、服务器 SSH 服务或终端 SSH 配置差异`,
    );
  }

  if (error instanceof Error) {
    // ssh2 对不同私钥格式（OpenSSH 旧/新格式、PPK）会返回不同文案。
    // 之前仅匹配单一字符串，导致部分“缺少口令/口令错误”场景泄露底层错误文本，用户难以判断应输入哪种凭据。
    // 这里改为模式化归一化，把同类错误稳定映射成产品语义提示，便于用户直接修正输入。
    if (isMissingPrivateKeyPassphraseMessage(error.message)) {
      return authenticationError("SSH 私钥需要口令：检测到加密私钥，但当前未提供私钥口令", error);
    }
    if (isInvalidPrivateKeyPassphraseMessage(error.message)) {
      return authenticationError("SSH 私钥口令错误：无法解密私钥，请检查私钥口令是否正确", error);
    }
    return error;
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error);
  }

  return new Error("SSH 连接失败");
}

function authenticationError(message: string, cause: unknown): Error {
  // 认证发生在懒连接的 probe 内；在仍有 ssh2 结构化原因的边界定码，避免被归成预检失败。
  return Object.assign(new Error(message, { cause }), {
    code: "remote-authentication-failed" satisfies PublicZCodeErrorCode,
  });
}
