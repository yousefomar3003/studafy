/**
 * QA-079: the app identifiers agree everywhere they are written down.
 *
 * The Android application id and iOS bundle id are permanent once a build is uploaded, and the API
 * names them too: the OAuth `intent://` redirect delivers the sign-in handoff only to
 * ANDROID_PACKAGES' package (a mismatch breaks Android sign-in), and store purchase verification
 * checks APPLE_IAP_BUNDLE_ID / GOOGLE_PLAY_PACKAGE_NAME. Whatever final ids are chosen, changing
 * one place without the others fails here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { ANDROID_PACKAGES as PACKAGES } from "./mobile-redirect";

const ANDROID_PACKAGES: Record<keyof typeof PACKAGES, string> = PACKAGES;

const root = join(import.meta.dir, "../../../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

function one(pattern: RegExp, text: string, what: string): string {
  const match = pattern.exec(text);
  if (!match?.[1]) throw new Error(`${what} not found`);
  return match[1];
}

const gradle = read("apps/mobile/android/app/build.gradle.kts");
const androidId = one(/applicationId\s*=\s*"([^"]+)"/, gradle, "applicationId");
const suffix = (flavor: string) =>
  one(
    new RegExp(`create\\("${flavor}"\\)\\s*\\{[^}]*applicationIdSuffix\\s*=\\s*"([^"]+)"`),
    gradle,
    `${flavor} applicationIdSuffix`,
  );

const pbxproj = read("apps/mobile/ios/Runner.xcodeproj/project.pbxproj");
const iosIds = new Set(
  [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)]
    .map((m) => m[1]!.trim())
    .filter((id) => !id.endsWith(".RunnerTests")),
);

describe("app identifiers agree (QA-079)", () => {
  test("the API's Android intent allowlist matches Gradle, flavors included", () => {
    expect(ANDROID_PACKAGES.production).toBe(androidId);
    expect(ANDROID_PACKAGES.development).toBe(androidId + suffix("dev"));
    expect(ANDROID_PACKAGES.staging).toBe(androidId + suffix("staging"));
  });

  test("iOS has one base bundle id, with the same flavor suffixes as Android", () => {
    const [base] = [...iosIds].sort((a, b) => a.length - b.length);
    expect([...iosIds].sort()).toEqual(
      [base!, base! + suffix("dev"), base! + suffix("staging")].sort(),
    );
  });

  test("fastlane and match default to the same ids", () => {
    const appfile = read("apps/mobile/fastlane/Appfile");
    const matchfile = read("apps/mobile/fastlane/Matchfile");
    const [iosId] = [...iosIds].sort((a, b) => a.length - b.length);
    expect(
      one(/app_identifier\(ENV\["IOS_APP_IDENTIFIER"\] \|\| "([^"]+)"\)/, appfile, "Appfile ios"),
    ).toBe(iosId!);
    expect(
      one(
        /package_name\(ENV\["ANDROID_PACKAGE_NAME"\] \|\| "([^"]+)"\)/,
        appfile,
        "Appfile android",
      ),
    ).toBe(androidId);
    expect(
      one(
        /app_identifier\(\[ENV\["IOS_APP_IDENTIFIER"\] \|\| "([^"]+)"\]\)/,
        matchfile,
        "Matchfile",
      ),
    ).toBe(iosId!);
  });

  test("store purchase verification in the Fly configs names the same apps", () => {
    const [iosId] = [...iosIds].sort((a, b) => a.length - b.length);
    const api = read("infra/fly/api.toml");
    const workers = read("infra/fly/workers.toml");
    expect(one(/APPLE_IAP_BUNDLE_ID = "([^"]+)"/, api, "APPLE_IAP_BUNDLE_ID")).toBe(iosId!);
    expect(one(/GOOGLE_PLAY_PACKAGE_NAME = "([^"]+)"/, api, "api GOOGLE_PLAY_PACKAGE_NAME")).toBe(
      androidId,
    );
    expect(
      one(/GOOGLE_PLAY_PACKAGE_NAME = "([^"]+)"/, workers, "workers GOOGLE_PLAY_PACKAGE_NAME"),
    ).toBe(androidId);
  });
});
