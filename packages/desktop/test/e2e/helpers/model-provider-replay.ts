import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  startUpstreamReplayServer,
  type UpstreamReplayServer,
} from "./upstream-replay-server.js";
import { createE2EReplayFixtureVariables } from "./e2e-runtime-paths.js";
import { DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY } from "./network-capture-proxy.js";

const DESKTOP_DIR = resolve(import.meta.dirname, "../../..");
const UPSTREAM_REPLAY_FIXTURE_ROOT = resolve(
  DESKTOP_DIR,
  "test/e2e/fixtures/upstream",
);
const UPSTREAM_COMMON_REPLAY_FIXTURE_PATH = resolve(
  UPSTREAM_REPLAY_FIXTURE_ROOT,
  "common.json",
);

export async function startConversationModelProviderReplayServer(
  caseName: string,
): Promise<UpstreamReplayServer> {
  const captureDir = resolve(
    process.env.ZCODE_E2E_NETWORK_CAPTURE_DIR?.trim() ||
      resolve(homedir(), "..", ".e2e-network-capture"),
  );
  const server = await startUpstreamReplayServer({
    artifactPath: resolve(captureDir, `${caseName}.json`),
    fixtureVariables: createE2EReplayFixtureVariables(),
    fixturePaths: [
      UPSTREAM_COMMON_REPLAY_FIXTURE_PATH,
      resolve(
        UPSTREAM_REPLAY_FIXTURE_ROOT,
        "conversation-session",
        `${caseName}.json`,
      ),
    ],
  });

  process.env.E2E_PROVIDER_CAPTURE_MODE = "replay";
  process.env.E2E_PROVIDER_CAPTURE_PATH = server.artifactPath;
  process.env.E2E_PROVIDER_CAPTURE_PROXY_URL = server.baseUrl;
  process.env.E2E_PROVIDER_EXPECTED_HOST = `${server.host}:${server.port}`;
  process.env.E2E_PROVIDER_EXPECTED_PROTOCOL = "http";
  process.env.E2E_PROVIDER_RUNTIME_BASE_URL = server.baseUrl;
  process.env.NO_PROXY = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;
  process.env.no_proxy = DEFAULT_E2E_NETWORK_CAPTURE_NO_PROXY;

  return server;
}
