# Web Remote v3 Static Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated `/remote/v3` static deployment path for new mobile Web remote-control resources while keeping the existing `/remote` v2 deployment untouched.

**Architecture:** Keep v2 and v3 as separate build and publish chains that share the same Vite source app but use different `base` paths, Dockerfiles, nginx configs, image names, and k8s deployment files. Add one pure route helper so the Web app recognizes the QR remote-control route from the build base, with a dev fallback for the existing localhost `/remote` flow.

**Tech Stack:** TypeScript, Vite, React, Electron main process, nginx, Docker, bash, Vitest, pnpm.

---

### Task 1: Web Remote Route Base Helper

**Files:**
- Modify: `packages/shared/src/web-remote-control.ts`
- Test: `packages/shared/test/webRemoteControl.test.ts`
- Modify: `packages/web/src/main.tsx`
- Test: `packages/web/test/externalRelayFrameGapRecovery.test.ts`

- [ ] **Step 1: Add failing shared tests for route base resolution**

Add these tests in `packages/shared/test/webRemoteControl.test.ts` inside `describe("external relay QR helpers", ...)` or a new adjacent `describe("resolveWebRemoteControlRoutePathFromBaseUrl", ...)` block:

```ts
it("resolves the v2 QR route from the Vite remote base", () => {
  expect(resolveWebRemoteControlRoutePathFromBaseUrl("/remote/")).toBe("/remote");
});

it("resolves the v3 QR route from the Vite remote v3 base", () => {
  expect(resolveWebRemoteControlRoutePathFromBaseUrl("/remote/v3/")).toBe("/remote/v3");
});

it("keeps the existing dev QR route when Vite uses the root base", () => {
  expect(resolveWebRemoteControlRoutePathFromBaseUrl("/")).toBe("/remote");
});
```

Also add `resolveWebRemoteControlRoutePathFromBaseUrl` to the import list:

```ts
import {
  WEB_REMOTE_CONTROL_RELAY_AUTH_PROOF_VECTORS,
  WebRemoteControlCloseCodes,
  buildWebRemoteControlExternalQrUrl,
  parseWebRemoteControlExternalQrParams,
  resolveWebRemoteControlFailureReasonFromCloseCode,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlRoutePathFromBaseUrl,
  resolveWebRemoteControlWorkspaceKey,
} from "../src/web-remote-control.js";
```

- [ ] **Step 2: Run shared test and confirm it fails**

Run:

```bash
pnpm vitest run packages/shared/test/webRemoteControl.test.ts
```

Expected: FAIL with an export/import error for `resolveWebRemoteControlRoutePathFromBaseUrl`.

- [ ] **Step 3: Implement the shared helper**

Add this function in `packages/shared/src/web-remote-control.ts` near the existing QR helper functions:

```ts
export function resolveWebRemoteControlRoutePathFromBaseUrl(baseUrl: string): string {
  const rawBaseUrl = baseUrl.trim() || "/";
  let pathname = "/";

  try {
    pathname = new URL(rawBaseUrl, "https://zcode.invalid").pathname;
  } catch {
    pathname = rawBaseUrl.startsWith("/") ? rawBaseUrl : `/${rawBaseUrl}`;
  }

  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPathname === "/") {
    return "/remote";
  }
  return normalizedPathname;
}
```

- [ ] **Step 4: Run shared test and confirm it passes**

Run:

```bash
pnpm vitest run packages/shared/test/webRemoteControl.test.ts
```

Expected: PASS.

- [ ] **Step 5: Use the helper in the Web entry route check**

In `packages/web/src/main.tsx`, add the helper to the existing `@zcode/shared` import list:

```ts
import {
  parseWebRemoteControlExternalQrParams,
  resolveWebRemoteControlFailureReasonFromCloseCode,
  resolveWebRemoteControlInitialWorkspaceSelection,
  resolveWebRemoteControlRoutePathFromBaseUrl,
  resolveWebRemoteControlWorkspaceKey,
} from "@zcode/shared";
```

Replace `isWebRemoteControlRoute()` with:

```ts
function isWebRemoteControlRoute(): boolean {
  return window.location.pathname === resolveWebRemoteControlRoutePathFromBaseUrl(import.meta.env.BASE_URL);
}
```

- [ ] **Step 6: Add a Web test case for `/remote/v3`**

In `packages/web/test/externalRelayFrameGapRecovery.test.ts`, update `setupExternalRelayGlobals` to accept an optional pathname:

```ts
function setupExternalRelayGlobals(pathname = "/remote") {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: vi.fn(),
  });
  vi.stubGlobal("document", {
    title: "",
    visibilityState: "visible",
    documentElement: { classList: { toggle: vi.fn() } },
    getElementById: vi.fn(() => ({ nodeType: 1 })),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    matchMedia: () => ({ matches: false }),
    location: {
      pathname,
      search: "?sid=sid-1&hash=hash-1&t=1&mid=mid-1&app_version=1.0.0",
    },
  });
  vi.stubGlobal("navigator", {
    language: "zh-CN",
    languages: ["zh-CN"],
    onLine: true,
    userAgent: "Mobile Safari",
  });
  vi.stubGlobal("screen", {
    width: 390,
    height: 844,
    colorDepth: 24,
  });
}
```

Add a test that stubs the Vite base for v3 before importing `../src/main.js`:

```ts
it("starts external relay bootstrap on the v3 remote base path", async () => {
  vi.stubEnv("BASE_URL", "/remote/v3/");
  setupExternalRelayGlobals("/remote/v3");

  await import("../src/main.js");

  await vi.waitFor(() => {
    expect(testState.relayProtocolOptions).toHaveLength(1);
  });
});
```

In the same file's `afterEach`, add env cleanup beside the existing module/global cleanup:

```ts
vi.unstubAllEnvs();
```

- [ ] **Step 7: Run Web focused test**

Run:

```bash
pnpm vitest run packages/web/test/externalRelayFrameGapRecovery.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

Run:

```bash
git add packages/shared/src/web-remote-control.ts packages/shared/test/webRemoteControl.test.ts packages/web/src/main.tsx packages/web/test/externalRelayFrameGapRecovery.test.ts
git commit -m "fix(web-remote): resolve remote route from build base"
```

---

### Task 2: Root v3 Build Script

**Files:**
- Modify: `package.json`
- Test: `packages/desktop/test/root-build-scripts.test.ts`

- [ ] **Step 1: Add failing script test**

Add this test in `packages/desktop/test/root-build-scripts.test.ts`:

```ts
it("pnpm build:web-remote-control:v3 应使用 /remote/v3/ base 构建手机远控资源", () => {
  expect(rootPackageJson.scripts["build:web-remote-control:v3"]).toBe(
    "pnpm --filter @zcode/web exec vite build --base=/remote/v3/",
  );
});
```

- [ ] **Step 2: Run the focused script test and confirm it fails**

Run:

```bash
pnpm vitest run packages/desktop/test/root-build-scripts.test.ts
```

Expected: FAIL because `build:web-remote-control:v3` is undefined.

- [ ] **Step 3: Add the v3 build script**

In root `package.json`, keep the existing v2 script and add the v3 script next to it:

```json
"build:web-remote-control": "pnpm --filter @zcode/web exec vite build --base=/remote/",
"build:web-remote-control:v3": "pnpm --filter @zcode/web exec vite build --base=/remote/v3/",
```

- [ ] **Step 4: Run the focused script test and confirm it passes**

Run:

```bash
pnpm vitest run packages/desktop/test/root-build-scripts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add package.json packages/desktop/test/root-build-scripts.test.ts
git commit -m "build(web-remote): add v3 static build script"
```

---

### Task 3: v3 Static Image And Smoke Test

**Files:**
- Create: `Dockerfile.web-remote-control-v3`
- Create: `nginx.web-remote-control-v3.conf`
- Create: `scripts/test-web-remote-control-v3-docker-build.sh`

- [ ] **Step 1: Create the v3 Dockerfile**

Create `Dockerfile.web-remote-control-v3`:

```Dockerfile
# Web remote control v3 static deployment image.
# Build packages/web/dist before docker build with:
#   pnpm run build:web-remote-control:v3
# Keeping Node.js out of the Docker build avoids installing unrelated
# workspace native dependencies such as desktop/node-pty.

FROM nginx:alpine

COPY packages/web/dist /usr/share/nginx/html
COPY nginx.web-remote-control-v3.conf /etc/nginx/nginx.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1/remote/v3 || exit 1

CMD ["nginx", "-g", "daemon off;"]
```

- [ ] **Step 2: Create the v3 nginx config**

Create `nginx.web-remote-control-v3.conf`:

```nginx
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_comp_level 6;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/json
        application/javascript
        application/xml+rss
        application/x-javascript
        image/svg+xml;

    server {
        listen 80;
        server_name _;
        root /usr/share/nginx/html;
        index index.html;

        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;

        location = /remote/v3 {
            try_files /index.html =404;
            add_header Cache-Control "no-cache, no-store, must-revalidate" always;
            add_header Pragma "no-cache" always;
            add_header Expires "0" always;
            etag off;
            if_modified_since off;
        }

        location = /remote/v3/ {
            return 301 /remote/v3;
        }

        location = / {
            return 302 /remote/v3;
        }

        location ^~ /remote/v3/assets/ {
            # Bugfix: v3 资源必须挂在 /remote/v3 前缀下，避免被旧 /remote 服务或网关规则接管。
            alias /usr/share/nginx/html/assets/;
            expires 1y;
            add_header Cache-Control "public, immutable";
        }

        location ^~ /remote/v3/material-icons/ {
            # Bugfix: v3 public 资源同样保留 /remote/v3 前缀，避免文件图标请求落到旧服务。
            alias /usr/share/nginx/html/material-icons/;
            expires 1y;
            add_header Cache-Control "public, immutable";
        }

        location ~* \.(ico|png|jpg|jpeg|gif|svg|webp|avif|woff|woff2)$ {
            try_files $uri =404;
            expires 1y;
            add_header Cache-Control "public, immutable";
        }

        location ~* \.html$ {
            add_header Cache-Control "no-cache, no-store, must-revalidate" always;
            add_header Pragma "no-cache" always;
            add_header Expires "0" always;
            etag off;
            if_modified_since off;
        }

        location / {
            try_files $uri $uri/ /index.html;
        }
    }
}
```

- [ ] **Step 3: Create the v3 Docker smoke script**

Create `scripts/test-web-remote-control-v3-docker-build.sh`:

```bash
#!/usr/bin/env bash

set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-zcode-remote-mobile-v3-test}"
CONTAINER_NAME="${CONTAINER_NAME:-zcode-remote-mobile-v3-test}"
PORT="${PORT:-8081}"
DOCKERFILE="${DOCKERFILE:-Dockerfile.web-remote-control-v3}"

log() {
  printf '[web-remote-control-v3-test] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[web-remote-control-v3-test] missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

cleanup() {
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

test_url() {
  local path="$1"
  local expected="${2:-200}"
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}${path}")"
  if [ "$status" != "$expected" ]; then
    printf '[web-remote-control-v3-test] %s returned HTTP %s, expected %s\n' "$path" "$status" "$expected" >&2
    docker logs "$CONTAINER_NAME" >&2 || true
    exit 1
  fi
  log "${path} -> HTTP ${status}"
}

first_html_asset_path() {
  LC_ALL=C perl -ne 'print "$1\n" if /src="([^"]+\/assets\/[^"]+\.js)"/' packages/web/dist/index.html | head -n 1
}

require_command pnpm
require_command docker
require_command curl

log "building Vite web app"
pnpm run build:web-remote-control:v3

test -f packages/web/dist/index.html
test -d packages/web/dist/assets
test -d packages/web/dist/material-icons

ASSET_PATH="$(first_html_asset_path)"
if [ -z "$ASSET_PATH" ]; then
  echo "[web-remote-control-v3-test] failed to find script asset in dist/index.html" >&2
  exit 1
fi

case "$ASSET_PATH" in
  /remote/v3/assets/*) ;;
  *)
    printf '[web-remote-control-v3-test] expected Vite asset path to use /remote/v3/assets, got: %s\n' "$ASSET_PATH" >&2
    exit 1
    ;;
esac

log "building Docker image ${IMAGE_NAME}:latest"
docker build -f "$DOCKERFILE" -t "${IMAGE_NAME}:latest" .

cleanup
trap cleanup EXIT

log "starting container on localhost:${PORT}"
docker run -d --name "$CONTAINER_NAME" -p "${PORT}:80" "${IMAGE_NAME}:latest" >/dev/null

log "waiting for nginx"
for _ in $(seq 1 20); do
  if docker exec "$CONTAINER_NAME" wget --quiet --tries=1 --spider http://127.0.0.1/remote/v3; then
    break
  fi
  sleep 1
done

docker exec "$CONTAINER_NAME" wget --quiet --tries=1 --spider http://127.0.0.1/remote/v3

test_url / 302
test_url /remote/v3 200
test_url /remote/v3/ 301
test_url "$ASSET_PATH" 200
test_url /remote/v3/material-icons/typescript.svg 200

log "Docker smoke test passed: http://127.0.0.1:${PORT}/remote/v3"
```

- [ ] **Step 4: Make the smoke script executable**

Run:

```bash
chmod +x scripts/test-web-remote-control-v3-docker-build.sh
```

- [ ] **Step 5: Run v3 Vite build**

Run:

```bash
pnpm run build:web-remote-control:v3
```

Expected: PASS and `packages/web/dist/index.html` references `/remote/v3/assets/`.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add Dockerfile.web-remote-control-v3 nginx.web-remote-control-v3.conf scripts/test-web-remote-control-v3-docker-build.sh
git commit -m "build(web-remote): add v3 static image smoke test"
```

---

### Task 4: v3 Publish Script

**Files:**
- Create: `scripts/docker-build-and-push-web-remote-control-v3.sh`

- [ ] **Step 1: Create the v3 publish script from the v2 script**

Copy `scripts/docker-build-and-push-web-remote-control.sh` to
`scripts/docker-build-and-push-web-remote-control-v3.sh`, then apply these exact changes:

```diff
-IMAGE_NAME="${DOCKER_IMAGE_NAME:-uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v2}"
-DOCKERFILE="${DOCKERFILE:-Dockerfile.web-remote-control}"
+IMAGE_NAME="${DOCKER_IMAGE_NAME:-uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v3}"
+DOCKERFILE="${DOCKERFILE:-Dockerfile.web-remote-control-v3}"
@@
-K8S_DEPLOYMENT_FILE="${K8S_DEPLOYMENT_FILE:-zcode/frontend/deployment-remote.yaml}"
+K8S_DEPLOYMENT_FILE="${K8S_DEPLOYMENT_FILE:-zcode/frontend/deployment-remote-v3.yaml}"
@@
-  DOCKER_IMAGE_NAME         Full image name. Default: uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v2
+  DOCKER_IMAGE_NAME         Full image name. Default: uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v3
@@
-  K8S_DEPLOYMENT_FILE       Deployment YAML path relative to K8S_REPO_DIR. Default: zcode/frontend/deployment-remote.yaml
+  K8S_DEPLOYMENT_FILE       Deployment YAML path relative to K8S_REPO_DIR. Default: zcode/frontend/deployment-remote-v3.yaml
@@
-  local branch_name="${K8S_BRANCH_NAME:-deploy/zcode-remote-mobile-v2-$TAG}"
-  local mr_title="chore: update zcode remote image to $TAG"
+  local branch_name="${K8S_BRANCH_NAME:-deploy/zcode-remote-mobile-v3-$TAG}"
+  local mr_title="chore: update zcode remote v3 image to $TAG"
@@
-    # Bugfix: 发布远控镜像后之前还需要手动去 k8s 仓库改 image，容易漏发或写错 tag。
-    # 这里只替换 deployment 中第一条 image 字段，保持其他 YAML 内容和缩进不变。
+    # Bugfix: v3 远控资源使用独立 deployment，发布脚本只能更新 deployment-remote-v3.yaml，
+    # 避免新版本镜像误覆盖仍服务 /remote 的老资源。
@@
-pnpm run build:web-remote-control
+pnpm run build:web-remote-control:v3
```

- [ ] **Step 2: Make the publish script executable**

Run:

```bash
chmod +x scripts/docker-build-and-push-web-remote-control-v3.sh
```

- [ ] **Step 3: Run shell syntax check**

Run:

```bash
bash -n scripts/docker-build-and-push-web-remote-control-v3.sh
```

Expected: PASS with no output.

- [ ] **Step 4: Verify v3 defaults are present and v2 deployment is not referenced**

Run:

```bash
rg -n "zcode-remote-mobile-v3|deployment-remote-v3|build:web-remote-control:v3" scripts/docker-build-and-push-web-remote-control-v3.sh
rg -n "deployment-remote\\.yaml|zcode-remote-mobile-v2|build:web-remote-control$" scripts/docker-build-and-push-web-remote-control-v3.sh
```

Expected: first command prints v3 matches; second command prints no matches.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add scripts/docker-build-and-push-web-remote-control-v3.sh
git commit -m "build(web-remote): add v3 image publish script"
```

---

### Task 5: Desktop QR URL Defaults

**Files:**
- Modify: `packages/desktop/src/main/index.ts`
- Test: `packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`
- Test: `packages/desktop/test/root-build-scripts.test.ts`

- [ ] **Step 1: Add failing static default URL test**

In `packages/desktop/test/root-build-scripts.test.ts`, read `packages/desktop/src/main/index.ts` and assert the default URL:

```ts
const desktopMainIndexSource = readFileSync(
  resolve(import.meta.dirname, "../src/main/index.ts"),
  "utf8",
).replace(/\r\n/g, "\n");
```

Add this test:

```ts
it("desktop 新版本默认二维码 URL 应指向 /remote/v3", () => {
  expect(desktopMainIndexSource).toContain(
    'process.env["ZCODE_WEB_REMOTE_CONTROL_URL"]?.trim() || "https://zcode.z.ai/remote/v3"',
  );
});
```

- [ ] **Step 2: Update the manager harness expected URL to v3**

In `packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`, change the harness dependency:

```ts
mobileRemoteControlUrl: "https://zcode.z.ai/remote/v3",
```

Change assertions:

```ts
expect(status.qrUrl).toContain("/remote/v3?");
```

and:

```ts
qrUrl: expect.stringContaining("/remote/v3?"),
```

- [ ] **Step 3: Run focused desktop tests and confirm failure**

Run:

```bash
pnpm vitest run packages/desktop/test/root-build-scripts.test.ts packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts
```

Expected: FAIL because `packages/desktop/src/main/index.ts` still defaults to `/remote`.

- [ ] **Step 4: Change the desktop default URL**

In `packages/desktop/src/main/index.ts`, update the fallback:

```ts
mobileRemoteControlUrl:
  process.env["ZCODE_WEB_REMOTE_CONTROL_URL"]?.trim() || "https://zcode.z.ai/remote/v3",
```

- [ ] **Step 5: Run focused desktop tests and confirm pass**

Run:

```bash
pnpm vitest run packages/desktop/test/root-build-scripts.test.ts packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

Run:

```bash
git add packages/desktop/src/main/index.ts packages/desktop/test/root-build-scripts.test.ts packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts
git commit -m "feat(web-remote): point desktop QR URL to v3"
```

---

### Task 6: Architecture Docs And Full Verification

**Files:**
- Modify: `docs/web-remote-control/web-remote-control-architecture.md`

- [ ] **Step 1: Update static deployment docs**

In `docs/web-remote-control/web-remote-control-architecture.md`, update the static deployment section to describe both paths:

````md
## 静态部署

手机远控页是 `packages/web` 的 Vite SPA，不使用 Next.js 静态导出，也不存在
`remote.html` 这类页面文件。

当前保留两条静态部署链路：

```text
v2:
  pnpm run build:web-remote-control
  -> packages/web/dist
  -> Dockerfile.web-remote-control
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v2
  -> /remote

v3:
  pnpm run build:web-remote-control:v3
  -> packages/web/dist
  -> Dockerfile.web-remote-control-v3
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v3
  -> /remote/v3
```

`/remote` 是旧资源入口，仍由 `deployment-remote.yaml` 更新。
`/remote/v3` 是新资源入口，发布脚本只更新 `deployment-remote-v3.yaml`。
两条链路使用独立 nginx 配置和镜像，避免新版本发布覆盖老资源。
````

Also update the build/push examples to include:

```bash
pnpm run build:web-remote-control:v3
bash scripts/test-web-remote-control-v3-docker-build.sh
export DOCKER_REGISTRY_PASSWORD='***'
bash scripts/docker-build-and-push-web-remote-control-v3.sh --tag 202604291800
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
pnpm vitest run packages/shared/test/webRemoteControl.test.ts packages/web/test/externalRelayFrameGapRecovery.test.ts packages/desktop/test/root-build-scripts.test.ts packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run v2 and v3 Vite builds**

Run:

```bash
pnpm run build:web-remote-control
pnpm run build:web-remote-control:v3
```

Expected: both builds PASS. After the v3 build, `packages/web/dist/index.html` references `/remote/v3/assets/`.

- [ ] **Step 4: Run shell syntax checks**

Run:

```bash
bash -n scripts/docker-build-and-push-web-remote-control.sh
bash -n scripts/docker-build-and-push-web-remote-control-v3.sh
bash -n scripts/test-web-remote-control-docker-build.sh
bash -n scripts/test-web-remote-control-v3-docker-build.sh
```

Expected: PASS with no output.

- [ ] **Step 5: Run mandatory repository checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: PASS.

- [ ] **Step 6: Run Docker smoke tests if Docker is available**

Run:

```bash
bash scripts/test-web-remote-control-docker-build.sh
bash scripts/test-web-remote-control-v3-docker-build.sh
```

Expected: both scripts PASS. If Docker is unavailable, record the exact Docker error in the final summary and keep the Vite build checks as the static-resource verification.

- [ ] **Step 7: Commit Task 6**

Run:

```bash
git add docs/web-remote-control/web-remote-control-architecture.md
git commit -m "docs(web-remote): document v3 static deployment"
```

- [ ] **Step 8: Final status check**

Run:

```bash
git status --short
```

Expected: clean worktree.
