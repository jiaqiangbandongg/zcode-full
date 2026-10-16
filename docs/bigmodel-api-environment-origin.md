# BigModel API Environment Origin

## Goal

BigModel API traffic should follow the selected product environment without changing
non-API links.

## Rules

- `ZCODE_ENV=production` uses `https://bigmodel.cn` for BigModel API requests.
- `ZCODE_ENV=test` uses `https://bigmodel.cn` for BigModel API requests.
- `BIGMODEL_API_BASE_URL` may override the selected API origin for local debugging.
- `BIGMODEL_TEST_API_BASE_URL` and `BIGMODEL_PRODUCTION_API_BASE_URL` are scoped
  overrides, following the same pattern as Z.ai test/production endpoint config.
- BigModel OAuth authorize/login uses the same environment main domain with
  `/login`, so `ZCODE_ENV=test` opens `https://bigmodel.cn/login`.
- Docs, purchase pages, and model runtime subdomains such as `open.bigmodel.cn`
  are not changed by this environment switch.
- The selected origin is resolved by the shared endpoint resolver in
  `packages/shared/src/zcodeEndpoint.ts`; service-side OAuth and provider code should
  pass runtime `env` into that resolver instead of reading compiled globals.

## Covered Request Types

- Coding Plan subscription APIs under `/api/biz`.
- Coding Plan usage quota APIs under `/api/monitor`.
- BigModel OAuth userinfo APIs under `/api/biz/customer`.
- BigModel API key exchange APIs that use the root BigModel API host.
