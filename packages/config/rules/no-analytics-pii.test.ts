// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, it } from "bun:test";
import { RuleTester } from "eslint";

import noAnalyticsPii from "./no-analytics-pii.js";

// RuleTester drives its own describe/it blocks (Mocha-shaped by default); pointing it at bun:test's
// globals is the documented way to run it under a non-Mocha framework.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

ruleTester.run("no-analytics-pii", noAnalyticsPii, {
  valid: [
    'track("registration_started")',
    'track("registration_step_completed", { step: "school" })',
    'track("feature_used", { feature: FEATURES[stepId] })',
    'track("registration_failed", { reason: apiError?.code ?? "unknown" })',
    // A same-named function that isn't the analytics tracker is out of scope for this rule.
    'otherTrack("x", { email: user.email })',
  ],
  invalid: [
    {
      code: 'track("x", { email: "a@b.com" })',
      errors: [{ messageId: "pii" }],
    },
    {
      code: 'track("x", { admin_email: values.admin_email })',
      errors: [{ messageId: "pii" }],
    },
    {
      code: 'track("x", { contact: schoolDetails.email })',
      errors: [{ messageId: "pii" }],
    },
    {
      code: 'track("x", { displayName: user.displayName })',
      errors: [{ messageId: "pii" }],
    },
    {
      code: 'track("x", { username: "jdoe" })',
      errors: [{ messageId: "pii" }],
    },
  ],
});
