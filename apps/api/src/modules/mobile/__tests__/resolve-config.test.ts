// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { loadEnv } from "../../../env";
import { EMPTY_MOBILE_RELEASE_CONFIG, resolveMobileReleaseConfig } from "../config";

describe("resolveMobileReleaseConfig", () => {
  test("an empty environment resolves every field to 0.0.0", () => {
    expect(resolveMobileReleaseConfig(loadEnv({}))).toEqual(EMPTY_MOBILE_RELEASE_CONFIG);
  });

  test("maps each variable onto its platform and field", () => {
    const config = resolveMobileReleaseConfig(
      loadEnv({
        MOBILE_MIN_SUPPORTED_VERSION_IOS: "1.2.0",
        MOBILE_LATEST_VERSION_IOS: "1.5.1",
        MOBILE_MIN_SUPPORTED_VERSION_ANDROID: "1.3.0",
        MOBILE_LATEST_VERSION_ANDROID: "1.5.0",
      }),
    );

    expect(config).toEqual({
      ios: { minimum_supported_version: "1.2.0", latest_version: "1.5.1" },
      android: { minimum_supported_version: "1.3.0", latest_version: "1.5.0" },
    });
  });

  test("a platform set on one axis only keeps 0.0.0 on the other", () => {
    const config = resolveMobileReleaseConfig(
      loadEnv({ MOBILE_MIN_SUPPORTED_VERSION_IOS: "2.0.0" }),
    );

    expect(config.ios).toEqual({ minimum_supported_version: "2.0.0", latest_version: "0.0.0" });
    expect(config.android).toEqual(EMPTY_MOBILE_RELEASE_CONFIG.android);
  });

  test("a non x.y.z value fails environment validation rather than reaching the route", () => {
    expect(() => loadEnv({ MOBILE_MIN_SUPPORTED_VERSION_IOS: "1.2" })).toThrow();
    expect(() => loadEnv({ MOBILE_LATEST_VERSION_ANDROID: "v1.2.3" })).toThrow();
  });
});
