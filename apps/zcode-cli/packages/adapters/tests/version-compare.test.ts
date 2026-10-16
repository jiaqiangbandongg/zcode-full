import { describe, expect, it } from "vitest";
import { comparePluginUpdate, comparePluginVersions } from "../src/plugins/version-compare.js";

describe("comparePluginVersions", () => {
  it("reports update-available when latest is strictly greater", () => {
    expect(comparePluginVersions({ installed: "1.0.0", latest: "1.1.0" })).toBe("update-available");
  });
  it("reports none when equal", () => {
    expect(comparePluginVersions({ installed: "2.3.4", latest: "2.3.4" })).toBe("none");
  });
  it("reports none when latest is older", () => {
    expect(comparePluginVersions({ installed: "2.0.0", latest: "1.0.0" })).toBe("none");
  });
  it("reports version-changed for non-semver differing versions", () => {
    expect(comparePluginVersions({ installed: "abc", latest: "def" })).toBe("version-changed");
  });
  it("reports none for non-semver equal versions", () => {
    expect(comparePluginVersions({ installed: "abc", latest: "abc" })).toBe("none");
  });
  it("reports none when either version is missing", () => {
    expect(comparePluginVersions({ installed: undefined, latest: "1.0.0" })).toBe("none");
    expect(comparePluginVersions({ installed: "1.0.0", latest: undefined })).toBe("none");
  });
});

describe("comparePluginUpdate", () => {
  // Version axis: only when the manifest (latest) advertises a semver version.
  it("uses the version axis when the manifest entry has a version", () => {
    expect(
      comparePluginUpdate({
        installedVersion: "1.0.0",
        installedSha: undefined,
        latestVersion: "1.2.0",
        latestSha: undefined,
      }),
    ).toBe("update-available");
    expect(
      comparePluginUpdate({
        installedVersion: "2.0.0",
        installedSha: undefined,
        latestVersion: "2.0.0",
        latestSha: undefined,
      }),
    ).toBe("none");
  });

  // Sha axis: the common Claude-official case — manifest entry pins a commit sha, no version.
  it("uses the sha axis when the manifest entry pins a sha and has no version", () => {
    expect(
      comparePluginUpdate({
        installedVersion: "0.0.0",
        installedSha: "295ab93b7d765912ee1a0dc7f1abb0ecaf73f138",
        latestVersion: undefined,
        latestSha: "896224c4aa11deadbeefcafef00dba5eed1234567",
      }),
    ).toBe("update-available");
    expect(
      comparePluginUpdate({
        installedVersion: "6.0.3",
        installedSha: "295ab93b7d765912ee1a0dc7f1abb0ecaf73f138",
        latestVersion: undefined,
        latestSha: "295ab93b7d765912ee1a0dc7f1abb0ecaf73f138",
      }),
    ).toBe("none");
  });

  // Manifest pins a sha but the installed record has none to compare → surface as changed.
  it("reports version-changed when the manifest pins a sha but the installed record has none", () => {
    expect(
      comparePluginUpdate({
        installedVersion: "0.0.0",
        installedSha: undefined,
        latestVersion: undefined,
        latestSha: "896224c4aa11deadbeefcafef00dba5eed1234567",
      }),
    ).toBe("version-changed");
  });

  // Prefer the version axis (ordered) when the manifest entry carries both version and sha.
  it("prefers the version axis when the manifest entry has both version and sha", () => {
    expect(
      comparePluginUpdate({
        installedVersion: "2.0.6",
        installedSha: "oldsha",
        latestVersion: "2.0.6",
        latestSha: "newsha",
      }),
    ).toBe("none");
  });

  // Local-path plugins (no version, no sha on either side) are Phase 2 → no false positives.
  it("reports none when neither side has a comparable pin (local path)", () => {
    expect(
      comparePluginUpdate({
        installedVersion: "0.0.0",
        installedSha: undefined,
        latestVersion: undefined,
        latestSha: undefined,
      }),
    ).toBe("none");
  });
});

