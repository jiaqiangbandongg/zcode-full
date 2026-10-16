# Web Remote Login

This document is scoped to the OAuth-gated `/web-remote` page only.
The QR route `/remote` is not OAuth-gated: it uses external relay
parameters `sid/hash/t/mid/name/app_version` and must not pass relay auth
material through OAuth state or safe-return helpers.

Historical `remoteControlToken` / `relayOrigin` notes below only describe old
`/web-remote` compatibility behavior and do not apply to `/remote`.

## Runtime Flow

- `/web-remote/callback` renders the OAuth callback page and delegates callback handling to `WebAuthService`.
- Unauthenticated Web remote visits render the lightweight login page and start Z.AI OAuth with `state = base64url(JSON.stringify({ nonce, app_return_to, return_to? }))`.
- Authenticated visits with `remoteControlToken` continue the existing relay bootstrap path.
- Authenticated visits without `remoteControlToken` render the logged-in waiting page until the device-list backend is available.
- Non-remote Web + Server routes keep the existing `/ws` and `/ws/remote/:id` bootstrap behavior.

## Storage

The web runtime stores the same core keys as desktop Z.AI login:

- `zcodejwttoken`
- `oauth:zai:access_token`
- `oauth:zai:user_info`
- `oauth:active_provider`

`BrowserOAuthCredentialRepo` is the only browser storage boundary for this flow. It restores a cached session only when all required keys are present and valid; partial Z.AI state is cleared and treated as logged out.

## Development Callback Relay

Local development may set:

```bash
VITE_DEV_ORIGIN=http://192.168.x.x:5173
```

This only writes `return_to` into OAuth state. A deployed callback page will forward to that private-origin callback only when its own build explicitly enables:

```bash
VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO=true
```

The Vite dev server proxies `/api/v1/oauth/token` to `https://zcode.z.ai` before the generic `/api` proxy so local token exchange does not accidentally hit the local server.
