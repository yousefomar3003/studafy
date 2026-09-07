import type { MobileReleaseConfig } from "./schemas";
import type { Env } from "../../env";

/** The value both version fields take when their environment variable is unset: "no floor". */
const UNSET_VERSION = "0.0.0";

/**
 * The config with every field at its "unset" value. The default when `createApp` is called without
 * a `mobileReleaseConfig` (tests, the OpenAPI generator) — the route still mounts and answers, it
 * just never forces an update.
 */
export const EMPTY_MOBILE_RELEASE_CONFIG: MobileReleaseConfig = {
  ios: { minimum_supported_version: UNSET_VERSION, latest_version: UNSET_VERSION },
  android: { minimum_supported_version: UNSET_VERSION, latest_version: UNSET_VERSION },
};

/**
 * Fold the four `MOBILE_*_VERSION_*` environment variables into the shape
 * {@link mobileConfigRoutes} serves. A missing variable becomes `0.0.0` here rather than at the
 * route, so the served object is always complete and the route stays a plain echo.
 */
export function resolveMobileReleaseConfig(env: Env): MobileReleaseConfig {
  return {
    ios: {
      minimum_supported_version: env.MOBILE_MIN_SUPPORTED_VERSION_IOS ?? UNSET_VERSION,
      latest_version: env.MOBILE_LATEST_VERSION_IOS ?? UNSET_VERSION,
    },
    android: {
      minimum_supported_version: env.MOBILE_MIN_SUPPORTED_VERSION_ANDROID ?? UNSET_VERSION,
      latest_version: env.MOBILE_LATEST_VERSION_ANDROID ?? UNSET_VERSION,
    },
  };
}
