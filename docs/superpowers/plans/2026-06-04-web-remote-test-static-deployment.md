# Web Remote Test Static Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated `/remote/__test__` static deployment path for Web remote-control test assets while leaving `/remote`, `/remote/v3`, and the desktop default QR URL unchanged.

**Architecture:** Keep test assets on a third parallel static deployment chain that shares the existing `packages/web` Vite SPA but uses its own Vite `base`, Dockerfile, nginx config, local smoke test, image name, and k8s deployment update script. The Web app already derives the QR route from `import.meta.env.BASE_URL`, so implementation only needs a route regression test and deployment artifacts. Desktop testing uses `ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.z.ai/remote/__test__`; no desktop default URL changes are part of this plan.

**Tech Stack:** pnpm, Vite, nginx, Docker, bash, Vitest, TypeScript, oxlint.

---

## File Structure

- Modify `package.json` — add `build:web-remote-control:test` with Vite base `/remote/__test__/`.
- Modify `packages/shared/test/webRemoteControl.test.ts` — add route-helper regression coverage for `/remote/__test__/`.
- Modify `packages/desktop/test/root-build-scripts.test.ts` — add static checks for the test build script, Dockerfile, nginx config, smoke test script, and publish script.
- Create `Dockerfile.web-remote-control-test` — package prebuilt `packages/web/dist` into an nginx image serving `/remote/__test__`.
- Create `nginx.web-remote-control-test.conf` — static nginx config scoped to `/remote/__test__`.
- Create `scripts/test-web-remote-control-test-docker-build.sh` — build and smoke-test the test image locally.
- Create `scripts/docker-build-and-push-web-remote-control-test.sh` — build, push, and create a cgx-dev-k8s MR that updates `zcode/frontend/deployment-remote-test.yaml`.
- Modify `docs/web-remote-control/web-remote-control-architecture.md` — document the third static deployment chain and verification commands.

### Task 1: Route And Build Script

**Files:**
- Modify: `packages/shared/test/webRemoteControl.test.ts`
- Modify: `packages/desktop/test/root-build-scripts.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the failing route-helper and package-script tests**

In `packages/shared/test/webRemoteControl.test.ts`, add this case inside `describe("resolveWebRemoteControlRoutePathFromBaseUrl", () => { ... })`, after the v3 case:

```ts
  it("resolves the test QR route from the Vite remote test base", () => {
    expect(resolveWebRemoteControlRoutePathFromBaseUrl("/remote/__test__/")).toBe(
      "/remote/__test__",
    );
  });
```

In `packages/desktop/test/root-build-scripts.test.ts`, add this case after the existing v3 build-script case:

```ts
  it("pnpm build:web-remote-control:test 应使用 /remote/__test__/ base 构建测试远控资源", () => {
    expect(rootPackageJson.scripts["build:web-remote-control:test"]).toBe(
      "pnpm --filter @zcode/web exec vite build --base=/remote/__test__/",
    );
  });
```

- [ ] **Step 2: Run tests and verify the red state**

Run:

```bash
pnpm vitest run packages/shared/test/webRemoteControl.test.ts packages/desktop/test/root-build-scripts.test.ts
```

Expected: FAIL because `rootPackageJson.scripts["build:web-remote-control:test"]` is `undefined`. The shared route-helper test may already pass because the helper normalizes arbitrary Vite base paths.

- [ ] **Step 3: Add the test build script**

In `package.json`, add the test script immediately after `build:web-remote-control:v3`:

```json
    "build:web-remote-control": "pnpm --filter @zcode/web exec vite build --base=/remote/",
    "build:web-remote-control:v3": "pnpm --filter @zcode/web exec vite build --base=/remote/v3/",
    "build:web-remote-control:test": "pnpm --filter @zcode/web exec vite build --base=/remote/__test__/",
    "build:bootstrap": "pnpm -r --filter \"./packages/*\" --filter \"!@zcode/desktop\" build && pnpm --filter @zcode/desktop build:no-runtime-assets",
```

- [ ] **Step 4: Run tests and verify the green state**

Run:

```bash
pnpm vitest run packages/shared/test/webRemoteControl.test.ts packages/desktop/test/root-build-scripts.test.ts
```

Expected: PASS. The route-helper suite includes v2, v3, test, and root-base cases; the root build-script suite now proves the new test build command uses `/remote/__test__/`.

- [ ] **Step 5: Commit**

```bash
git add package.json packages/shared/test/webRemoteControl.test.ts packages/desktop/test/root-build-scripts.test.ts
git commit -m "feat(web): add remote test build path"
```

### Task 2: Static Container Artifacts

**Files:**
- Modify: `packages/desktop/test/root-build-scripts.test.ts`
- Create: `Dockerfile.web-remote-control-test`
- Create: `nginx.web-remote-control-test.conf`
- Create: `scripts/test-web-remote-control-test-docker-build.sh`

- [ ] **Step 1: Add failing static artifact tests**

In `packages/desktop/test/root-build-scripts.test.ts`, add these path constants after `desktopMainIndexPath`:

```ts
const webRemoteControlTestDockerfilePath = resolve(
  import.meta.dirname,
  "../../../Dockerfile.web-remote-control-test",
);
const webRemoteControlTestNginxConfigPath = resolve(
  import.meta.dirname,
  "../../../nginx.web-remote-control-test.conf",
);
const webRemoteControlTestSmokeScriptPath = resolve(
  import.meta.dirname,
  "../../../scripts/test-web-remote-control-test-docker-build.sh",
);
```

Add these source constants after `desktopMainIndexSource`:

```ts
const webRemoteControlTestDockerfileSource = readFileSync(
  webRemoteControlTestDockerfilePath,
  "utf8",
).replace(/\r\n/g, "\n");
const webRemoteControlTestNginxConfigSource = readFileSync(
  webRemoteControlTestNginxConfigPath,
  "utf8",
).replace(/\r\n/g, "\n");
const webRemoteControlTestSmokeScriptSource = readFileSync(
  webRemoteControlTestSmokeScriptPath,
  "utf8",
).replace(/\r\n/g, "\n");
```

Add these tests after the new `build:web-remote-control:test` case:

```ts
  it("remote test Dockerfile 应使用 test nginx 配置并健康检查 /remote/__test__", () => {
    expect(webRemoteControlTestDockerfileSource).toContain(
      "COPY nginx.web-remote-control-test.conf /etc/nginx/nginx.conf",
    );
    expect(webRemoteControlTestDockerfileSource).toContain(
      "http://127.0.0.1/remote/__test__",
    );
    expect(webRemoteControlTestDockerfileSource).not.toContain("remote/v3");
  });

  it("remote test nginx 配置应只服务 /remote/__test__ 资源前缀", () => {
    expect(webRemoteControlTestNginxConfigSource).toContain("location = /remote/__test__");
    expect(webRemoteControlTestNginxConfigSource).toContain(
      "location ^~ /remote/__test__/assets/",
    );
    expect(webRemoteControlTestNginxConfigSource).toContain(
      "location ^~ /remote/__test__/material-icons/",
    );
    expect(webRemoteControlTestNginxConfigSource).toContain("return 302 /remote/__test__");
    expect(webRemoteControlTestNginxConfigSource).not.toContain("location = /remote/v3");
  });

  it("remote test Docker smoke 脚本应验证 /remote/__test__ 构建和路由", () => {
    expect(webRemoteControlTestSmokeScriptSource).toContain(
      "pnpm run build:web-remote-control:test",
    );
    expect(webRemoteControlTestSmokeScriptSource).toContain("/remote/__test__/assets/*");
    expect(webRemoteControlTestSmokeScriptSource).toContain("test_url /remote/__test__ 200");
    expect(webRemoteControlTestSmokeScriptSource).toContain("test_url /remote/__test__/ 301");
    expect(webRemoteControlTestSmokeScriptSource).toContain(
      "test_url /remote/__test__/material-icons/typescript.svg 200",
    );
  });
```

- [ ] **Step 2: Run tests and verify the red state**

Run:

```bash
pnpm vitest run packages/desktop/test/root-build-scripts.test.ts
```

Expected: FAIL with an `ENOENT` error for `Dockerfile.web-remote-control-test`, `nginx.web-remote-control-test.conf`, or `scripts/test-web-remote-control-test-docker-build.sh`.

- [ ] **Step 3: Create the test Dockerfile**

Create `Dockerfile.web-remote-control-test`:

```dockerfile
# Web remote control test static deployment image.
# Build packages/web/dist before docker build with:
#   pnpm run build:web-remote-control:test
# Keeping Node.js out of the Docker build avoids installing unrelated
# workspace native dependencies such as desktop/node-pty.

FROM nginx:alpine

COPY packages/web/dist /usr/share/nginx/html
COPY nginx.web-remote-control-test.conf /etc/nginx/nginx.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1/remote/__test__ || exit 1

CMD ["nginx", "-g", "daemon off;"]
```

- [ ] **Step 4: Create the test nginx config**

Create `nginx.web-remote-control-test.conf`:

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

        location = /remote/__test__ {
            try_files /index.html =404;
            add_header Cache-Control "no-cache, no-store, must-revalidate" always;
            add_header Pragma "no-cache" always;
            add_header Expires "0" always;
            etag off;
            if_modified_since off;
        }

        location = /remote/__test__/ {
            return 301 /remote/__test__;
        }

        location = / {
            return 302 /remote/__test__;
        }

        location ^~ /remote/__test__/assets/ {
            # Test 远控资源必须挂在 /remote/__test__ 前缀下，避免被 /remote 或 /remote/v3 服务接管。
            alias /usr/share/nginx/html/assets/;
            expires 1y;
            add_header Cache-Control "public, immutable";
        }

        location ^~ /remote/__test__/material-icons/ {
            # Test public 资源同样保留 /remote/__test__ 前缀，避免文件图标请求落到其他远控服务。
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

- [ ] **Step 5: Create the test Docker smoke script**

Create `scripts/test-web-remote-control-test-docker-build.sh`:

```bash
#!/usr/bin/env bash

set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-zcode-remote-mobile-test}"
CONTAINER_NAME="${CONTAINER_NAME:-zcode-remote-mobile-test}"
PORT="${PORT:-8082}"
DOCKERFILE="${DOCKERFILE:-Dockerfile.web-remote-control-test}"

log() {
  printf '[web-remote-control-test] %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[web-remote-control-test] missing required command: %s\n' "$1" >&2
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
    printf '[web-remote-control-test] %s returned HTTP %s, expected %s\n' "$path" "$status" "$expected" >&2
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
pnpm run build:web-remote-control:test

test -f packages/web/dist/index.html
test -d packages/web/dist/assets
test -d packages/web/dist/material-icons

ASSET_PATH="$(first_html_asset_path)"
if [ -z "$ASSET_PATH" ]; then
  echo "[web-remote-control-test] failed to find script asset in dist/index.html" >&2
  exit 1
fi

case "$ASSET_PATH" in
  /remote/__test__/assets/*) ;;
  *)
    printf '[web-remote-control-test] expected Vite asset path to use /remote/__test__/assets, got: %s\n' "$ASSET_PATH" >&2
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
  if docker exec "$CONTAINER_NAME" wget --quiet --tries=1 --spider http://127.0.0.1/remote/__test__; then
    break
  fi
  sleep 1
done

docker exec "$CONTAINER_NAME" wget --quiet --tries=1 --spider http://127.0.0.1/remote/__test__

test_url / 302
test_url /remote/__test__ 200
test_url /remote/__test__/ 301
test_url "$ASSET_PATH" 200
test_url /remote/__test__/material-icons/typescript.svg 200

log "Docker smoke test passed: http://127.0.0.1:${PORT}/remote/__test__"
```

- [ ] **Step 6: Make the smoke script executable**

Run:

```bash
chmod +x scripts/test-web-remote-control-test-docker-build.sh
```

- [ ] **Step 7: Run static artifact tests**

Run:

```bash
pnpm vitest run packages/desktop/test/root-build-scripts.test.ts
```

Expected: PASS. The test file now proves the Dockerfile, nginx config, and smoke script are scoped to `/remote/__test__`.

- [ ] **Step 8: Run the test Vite build**

Run:

```bash
pnpm run build:web-remote-control:test
```

Expected: PASS and `packages/web/dist/index.html` references `/remote/__test__/assets/`.

- [ ] **Step 9: Commit**

```bash
git add Dockerfile.web-remote-control-test nginx.web-remote-control-test.conf scripts/test-web-remote-control-test-docker-build.sh packages/desktop/test/root-build-scripts.test.ts package.json packages/shared/test/webRemoteControl.test.ts
git commit -m "feat(web): add remote test static container"
```

### Task 3: Test Publish Script

**Files:**
- Modify: `packages/desktop/test/root-build-scripts.test.ts`
- Create: `scripts/docker-build-and-push-web-remote-control-test.sh`

- [ ] **Step 1: Add failing publish-script tests**

In `packages/desktop/test/root-build-scripts.test.ts`, add this path constant after `webRemoteControlTestSmokeScriptPath`:

```ts
const webRemoteControlTestPublishScriptPath = resolve(
  import.meta.dirname,
  "../../../scripts/docker-build-and-push-web-remote-control-test.sh",
);
```

Add this source constant after `webRemoteControlTestSmokeScriptSource`:

```ts
const webRemoteControlTestPublishScriptSource = readFileSync(
  webRemoteControlTestPublishScriptPath,
  "utf8",
).replace(/\r\n/g, "\n");
```

Add this test after the smoke-script test:

```ts
  it("remote test 发布脚本应只更新 deployment-remote-test.yaml", () => {
    expect(webRemoteControlTestPublishScriptSource).toContain(
      'IMAGE_NAME="${DOCKER_IMAGE_NAME:-uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-test}"',
    );
    expect(webRemoteControlTestPublishScriptSource).toContain(
      'DOCKERFILE="${DOCKERFILE:-Dockerfile.web-remote-control-test}"',
    );
    expect(webRemoteControlTestPublishScriptSource).toContain(
      'K8S_DEPLOYMENT_FILE="${K8S_DEPLOYMENT_FILE:-zcode/frontend/deployment-remote-test.yaml}"',
    );
    expect(webRemoteControlTestPublishScriptSource).toContain(
      'local branch_name="${K8S_BRANCH_NAME:-deploy/zcode-remote-mobile-test-$TAG}"',
    );
    expect(webRemoteControlTestPublishScriptSource).toContain(
      'local mr_title="chore: update zcode remote test image to $TAG"',
    );
    expect(webRemoteControlTestPublishScriptSource).toContain(
      "pnpm run build:web-remote-control:test",
    );
    expect(webRemoteControlTestPublishScriptSource).not.toContain("deployment-remote-v3.yaml");
    expect(webRemoteControlTestPublishScriptSource).not.toContain("zcode-remote-mobile-v3");
  });
```

- [ ] **Step 2: Run tests and verify the red state**

Run:

```bash
pnpm vitest run packages/desktop/test/root-build-scripts.test.ts
```

Expected: FAIL with an `ENOENT` error for `scripts/docker-build-and-push-web-remote-control-test.sh`.

- [ ] **Step 3: Create the publish script**

Create `scripts/docker-build-and-push-web-remote-control-test.sh`:

```bash
#!/usr/bin/env bash

set -euo pipefail

REGISTRY="${DOCKER_REGISTRY:-uhub.service.ucloud.cn}"
USERNAME="${DOCKER_REGISTRY_USERNAME:-dev@example.com}"
DEFAULT_PASSWORD="123456"
PASSWORD="${DOCKER_REGISTRY_PASSWORD:-$DEFAULT_PASSWORD}"
IMAGE_NAME="${DOCKER_IMAGE_NAME:-uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-test}"
DOCKERFILE="${DOCKERFILE:-Dockerfile.web-remote-control-test}"
PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
K8S_REPO_DIR="${K8S_REPO_DIR:-$HOME/workspace/cgx-dev-k8s}"
K8S_REMOTE="${K8S_REMOTE:-origin}"
K8S_BASE_BRANCH="${K8S_BASE_BRANCH:-main}"
K8S_DEPLOYMENT_FILE="${K8S_DEPLOYMENT_FILE:-zcode/frontend/deployment-remote-test.yaml}"
K8S_BRANCH_NAME="${K8S_BRANCH_NAME:-}"
TAG=""
SKIP_LOGIN=false
SKIP_MR=false

usage() {
  cat <<'USAGE'
Usage: scripts/docker-build-and-push-web-remote-control-test.sh [options]

Options:
  --tag TAG       Use a specific image tag. Defaults to UTC YYYYMMDDHHMM.
  --skip-login    Skip docker login.
  --skip-mr       Skip cgx-dev-k8s deployment update and merge request creation.
  -h, --help      Show this help.

Environment:
  DOCKER_REGISTRY_PASSWORD  Docker registry password. Defaults to 123456 for compatibility with the old manual publish command.
  DOCKER_REGISTRY           Registry host. Default: uhub.service.ucloud.cn
  DOCKER_REGISTRY_USERNAME  Registry username.
  DOCKER_IMAGE_NAME         Full image name. Default: uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-test
  DOCKER_PLATFORM           Build platform. Default: linux/amd64
  K8S_REPO_DIR              cgx-dev-k8s repo path. Default: ~/workspace/cgx-dev-k8s
  K8S_REMOTE                cgx-dev-k8s git remote. Default: origin
  K8S_BASE_BRANCH           Target branch to update from and merge into. Default: main
  K8S_DEPLOYMENT_FILE       Deployment YAML path relative to K8S_REPO_DIR. Default: zcode/frontend/deployment-remote-test.yaml
  K8S_BRANCH_NAME           Optional branch name for the deployment MR.
USAGE
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s is required.\n' "$command_name" >&2
    exit 1
  fi
}

run_docker_login() {
  set +e
  login_output="$(printf '%s\n' "$PASSWORD" | docker login -u "$USERNAME" --password-stdin "$REGISTRY" 2>&1)"
  login_status=$?
  set -e

  printf '%s\n' "$login_output"
}

is_macos_keychain_duplicate_error() {
  case "$1" in
    *"specified item already exists in the keychain"*|*"-25299"*) return 0 ;;
    *) return 1 ;;
  esac
}

docker_registry_login() {
  local login_output
  local login_status

  run_docker_login

  if [ "$login_status" -eq 0 ]; then
    return 0
  fi

  if ! is_macos_keychain_duplicate_error "$login_output"; then
    return "$login_status"
  fi

  # Bugfix: macOS Docker 使用 osxkeychain 保存登录态时，旧凭据残留会导致 Keychain 返回重复项错误。
  # 这里先清理当前 registry 的旧登录态再重试一次，避免发布脚本在真正构建和推送前被本机凭据缓存中断。
  printf 'Docker credential already exists in macOS Keychain, clearing stale credential and retrying login: %s\n' "$REGISTRY" >&2
  docker logout "$REGISTRY" >/dev/null 2>&1 || true
  if [ "$(uname -s)" = "Darwin" ] && command -v security >/dev/null 2>&1; then
    # Bugfix: OrbStack/Docker 29 后 macOS osxkeychain 可能把 registry 凭据写成 internet-password。
    # docker logout 没有删掉这类残留项时，下一次 docker login 会因同名条目已存在而失败。
    security delete-internet-password -s "$REGISTRY" -a "$USERNAME" >/dev/null 2>&1 || true
  fi
  run_docker_login

  if [ "$login_status" -eq 0 ]; then
    return 0
  fi

  if is_macos_keychain_duplicate_error "$login_output"; then
    printf 'Docker login still failed after clearing macOS Keychain credential for %s.\n' "$REGISTRY" >&2
  fi

  return "$login_status"
}

stash_dirty_git_repo() {
  local repo_dir="$1"
  local status
  status="$(git -C "$repo_dir" status --porcelain)"
  if [ -n "$status" ]; then
    printf 'Git repo has uncommitted changes, stashing before deployment update: %s\n' "$repo_dir" >&2
    printf '%s\n' "$status" >&2
    # Bugfix: 发布脚本需要临时切到 main 并创建部署分支；目标仓库不干净时直接退出会中断发布。
    # 这里把 tracked、staged 和 untracked 改动全部 stash 起来，避免 checkout/pull 覆盖用户本地工作。
    git -C "$repo_dir" stash push -u -m "auto-stash before zcode remote test image update $TAG"
  fi
}

update_k8s_deployment_and_create_mr() {
  local image_tag="$1"
  local repo_dir="$K8S_REPO_DIR"
  local deployment_file="$repo_dir/$K8S_DEPLOYMENT_FILE"
  local branch_name="${K8S_BRANCH_NAME:-deploy/zcode-remote-mobile-test-$TAG}"
  local mr_title="chore: update zcode remote test image to $TAG"
  local push_output
  local mr_url

  if [ ! -d "$repo_dir/.git" ]; then
    printf 'cgx-dev-k8s git repo not found: %s\n' "$repo_dir" >&2
    exit 1
  fi

  if [ ! -f "$deployment_file" ]; then
    printf 'Deployment file not found: %s\n' "$deployment_file" >&2
    exit 1
  fi

  stash_dirty_git_repo "$repo_dir"

  git -C "$repo_dir" fetch "$K8S_REMOTE" "$K8S_BASE_BRANCH"
  git -C "$repo_dir" checkout "$K8S_BASE_BRANCH"
  git -C "$repo_dir" pull --ff-only "$K8S_REMOTE" "$K8S_BASE_BRANCH"

  if git -C "$repo_dir" rev-parse --verify --quiet "refs/heads/$branch_name" >/dev/null; then
    printf 'Branch already exists in cgx-dev-k8s: %s\n' "$branch_name" >&2
    exit 1
  fi

  if git -C "$repo_dir" ls-remote --exit-code --heads "$K8S_REMOTE" "$branch_name" >/dev/null 2>&1; then
    printf 'Remote branch already exists in cgx-dev-k8s: %s\n' "$branch_name" >&2
    exit 1
  fi

  git -C "$repo_dir" checkout -b "$branch_name"

  # Test 远控资源使用独立 deployment，发布脚本只能更新 deployment-remote-test.yaml，
  # 避免测试镜像误覆盖仍服务 /remote 或 /remote/v3 的生产资源。
  NEW_IMAGE_TAG="$image_tag" perl -0pi -e 's|(^\s*image:\s*)\S+|${1}$ENV{NEW_IMAGE_TAG}|m' "$deployment_file"

  if ! grep -Fq "image: $image_tag" "$deployment_file"; then
    printf 'Failed to update image in %s\n' "$deployment_file" >&2
    exit 1
  fi

  git -C "$repo_dir" add "$K8S_DEPLOYMENT_FILE"
  git -C "$repo_dir" commit -m "$mr_title"

  set +e
  push_output="$(
    git -C "$repo_dir" push "$K8S_REMOTE" "HEAD:$branch_name" \
      -o merge_request.create \
      -o merge_request.target="$K8S_BASE_BRANCH" \
      -o merge_request.title="$mr_title" \
      -o merge_request.description="Update $K8S_DEPLOYMENT_FILE image to $image_tag." 2>&1
  )"
  local push_status=$?
  set -e

  printf '%s\n' "$push_output"

  if [ "$push_status" -ne 0 ]; then
    printf 'Failed to push deployment branch and create MR.\n' >&2
    exit "$push_status"
  fi

  mr_url="$(
    printf '%s\n' "$push_output" |
      sed -nE 's#.*(https?://[^[:space:]]+/-/merge_requests/[0-9]+).*#\1#p' |
      tail -n 1
  )"

  if [ -z "$mr_url" ]; then
    printf 'Image pushed and deployment branch created, but MR URL was not found in git push output.\n' >&2
    printf 'Branch: %s\n' "$branch_name" >&2
    exit 1
  fi

  printf 'Created MR: %s\n' "$mr_url"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      TAG="$2"
      shift 2
      ;;
    --tag=*)
      TAG="${1#*=}"
      shift
      ;;
    --skip-login)
      SKIP_LOGIN=true
      shift
      ;;
    --skip-mr)
      SKIP_MR=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage
      exit 1
      ;;
  esac
done

require_command docker
require_command git
require_command perl
require_command pnpm

if [ ! -f "$DOCKERFILE" ]; then
  printf 'Dockerfile not found: %s\n' "$DOCKERFILE" >&2
  exit 1
fi

if [ -z "$TAG" ]; then
  TAG="$(date -u +%Y%m%d%H%M)"
fi

IMAGE_TAG="${IMAGE_NAME}:${TAG}"

if [ "$SKIP_LOGIN" = false ]; then
  if [ "$PASSWORD" = "$DEFAULT_PASSWORD" ]; then
    echo "Using default Docker registry password. Set DOCKER_REGISTRY_PASSWORD to override it." >&2
  fi

  docker_registry_login
fi

pnpm run build:web-remote-control:test

docker build --platform "$PLATFORM" -f "$DOCKERFILE" -t "$IMAGE_TAG" .
docker push "$IMAGE_TAG"

printf 'Pushed image: %s\n' "$IMAGE_TAG"

if [ "$SKIP_MR" = false ]; then
  update_k8s_deployment_and_create_mr "$IMAGE_TAG"
fi
```

- [ ] **Step 4: Make the publish script executable**

Run:

```bash
chmod +x scripts/docker-build-and-push-web-remote-control-test.sh
```

- [ ] **Step 5: Run publish-script tests**

Run:

```bash
pnpm vitest run packages/desktop/test/root-build-scripts.test.ts
```

Expected: PASS. The root build-script tests prove the test publish script uses `zcode-remote-mobile-test`, `Dockerfile.web-remote-control-test`, `deployment-remote-test.yaml`, and `pnpm run build:web-remote-control:test`, while avoiding v3 deployment strings.

- [ ] **Step 6: Run shell parse checks**

Run:

```bash
bash -n scripts/docker-build-and-push-web-remote-control-test.sh
bash -n scripts/test-web-remote-control-test-docker-build.sh
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/docker-build-and-push-web-remote-control-test.sh scripts/test-web-remote-control-test-docker-build.sh packages/desktop/test/root-build-scripts.test.ts
git commit -m "feat(web): add remote test publish script"
```

### Task 4: Architecture Documentation

**Files:**
- Modify: `docs/web-remote-control/web-remote-control-architecture.md`

- [ ] **Step 1: Update the static deployment section**

In `docs/web-remote-control/web-remote-control-architecture.md`, replace the sentence `当前保留两条静态部署链路：` with:

```markdown
当前保留三条静态部署链路：
```

In the text block under that sentence, add the test chain after the v3 chain:

```markdown
test:
  -> pnpm run build:web-remote-control:test
  -> packages/web/dist
  -> Dockerfile.web-remote-control-test
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-test
  -> zcode/frontend/deployment-remote-test.yaml
  -> /remote/__test__
```

Replace the paragraph below the text block with:

```markdown
`/remote` 是旧资源入口，发布脚本仍更新 `deployment-remote.yaml`。
`/remote/v3` 是新资源入口，发布脚本只更新 `deployment-remote-v3.yaml`。
`/remote/__test__` 是测试资源入口，发布脚本只更新 `deployment-remote-test.yaml`。
三条链路使用独立 Dockerfile、nginx 配置、镜像名和 k8s deployment 文件，避免测试资源发布覆盖生产资源。
```

Update the local verification block to include:

```bash
pnpm run build:web-remote-control:test
bash scripts/test-web-remote-control-test-docker-build.sh
```

Update the publish block to include:

```bash
bash scripts/docker-build-and-push-web-remote-control-test.sh --tag 202604291800
```

After the publish block, add:

````markdown
Desktop 默认二维码 URL 不指向 `/remote/__test__`。需要验证测试资源时，通过环境变量覆盖：

```bash
ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.z.ai/remote/__test__ pnpm dev:desktop
```
````

- [ ] **Step 2: Verify the documentation text**

Run:

```bash
rg -n "remote/__test__|deployment-remote-test|docker-build-and-push-web-remote-control-test|build:web-remote-control:test" docs/web-remote-control/web-remote-control-architecture.md
```

Expected: output includes the test route, test deployment YAML, test publish script, and test build script.

- [ ] **Step 3: Commit**

```bash
git add docs/web-remote-control/web-remote-control-architecture.md
git commit -m "docs: document remote test deployment"
```

### Task 5: Full Verification

**Files:**
- Verify changed files only; no edits unless a command exposes a concrete issue.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
pnpm vitest run packages/shared/test/webRemoteControl.test.ts packages/desktop/test/root-build-scripts.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run mandatory checks**

Run:

```bash
pnpm run typecheck
pnpm run lint
```

Expected: `typecheck` exits 0. `lint` exits 0; repository warnings may be printed, but there must be 0 errors.

- [ ] **Step 3: Run Web remote-control builds**

Run:

```bash
pnpm run build:web-remote-control
pnpm run build:web-remote-control:v3
pnpm run build:web-remote-control:test
```

Expected: all three commands exit 0. After the test build, `packages/web/dist/index.html` references `/remote/__test__/assets/`.

- [ ] **Step 4: Run Docker smoke tests when Docker is available**

Run:

```bash
bash scripts/test-web-remote-control-docker-build.sh
bash scripts/test-web-remote-control-v3-docker-build.sh
bash scripts/test-web-remote-control-test-docker-build.sh
```

Expected: all three smoke tests exit 0. If Docker is unavailable in the current environment, record the exact Docker error in the final handoff and keep the Vite build verification from Step 3 as the non-container fallback.

- [ ] **Step 5: Inspect final diff and status**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: working tree is clean after the task commits. Recent commits include the test build path, test static container, test publish script, and architecture documentation.
