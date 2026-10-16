import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_DECRYPT_ERROR_CODE,
  CREDENTIAL_DECRYPT_ERROR_PREFIX,
  isCredentialDecryptError,
  resolveJwtExpiration,
} from "../src/oauth.js";

function createUnsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

describe("oauth errors", () => {
  it("recognizes credential decrypt errors by stable code", () => {
    expect(
      isCredentialDecryptError({
        code: CREDENTIAL_DECRYPT_ERROR_CODE,
        message: "serialized error without localized prefix",
      }),
    ).toBe(true);
  });

  it("keeps legacy message fallback only when code is missing", () => {
    expect(
      isCredentialDecryptError({
        message: `${CREDENTIAL_DECRYPT_ERROR_PREFIX}密钥不匹配或密文已损坏`,
      }),
    ).toBe(true);
  });

  it("does not let another error code match by localized message prefix", () => {
    expect(
      isCredentialDecryptError({
        code: "OTHER_ERROR",
        message: `${CREDENTIAL_DECRYPT_ERROR_PREFIX}业务错误`,
      }),
    ).toBe(false);
  });
});

describe("resolveJwtExpiration", () => {
  it("reports a JWT as expired with the configured clock skew", () => {
    const token = createUnsignedJwt({ exp: 1_000 });

    expect(resolveJwtExpiration(token, 1_030_000, 30_000)).toEqual({
      kind: "expired",
      expiresAt: 1_000_000,
    });
  });

  it("keeps a JWT valid before the expiration boundary", () => {
    const token = createUnsignedJwt({ exp: 1_001 });

    expect(resolveJwtExpiration(token, 970_000, 30_000)).toEqual({
      kind: "valid",
      expiresAt: 1_001_000,
    });
  });

  it.each(["legacy-token", createUnsignedJwt({ sub: "u-1" })])(
    "keeps an unprovable token compatible: %s",
    (token) => {
      expect(resolveJwtExpiration(token, 1_000_000, 30_000)).toEqual({ kind: "unknown" });
    },
  );
});
