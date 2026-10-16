# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.14-alpine
FROM ${NODE_IMAGE}

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ARG MBEARS_NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ARG INSTALL_CA_CERTIFICATES=false
ENV npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /repo

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN if [ "${INSTALL_CA_CERTIFICATES}" = "true" ]; then \
    if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache ca-certificates; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && \
      apt-get install -y --no-install-recommends ca-certificates && \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
  fi
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/bootstrap/package.json packages/bootstrap/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/debug/package.json packages/debug/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/swift-bridge/package.json packages/swift-bridge/package.json
COPY packages/tui/package.json packages/tui/package.json
COPY tools/typescript/package.json tools/typescript/package.json

RUN --mount=type=cache,id=zcode-pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store && \
  pnpm config set @mbears:registry ${MBEARS_NPM_CONFIG_REGISTRY} && \
  pnpm config set fetch-retries 5 && \
  pnpm config set fetch-retry-maxtimeout 120000 && \
  pnpm config set fetch-timeout 300000 && \
  pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENTRYPOINT ["node", "e2e/compact-microcompact/run.mjs"]
