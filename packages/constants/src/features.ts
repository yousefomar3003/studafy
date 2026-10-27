/**
 * The paid-feature registry (docs/billing/feature-licensing.md).
 *
 * The single source of truth for which paid features exist. Adding a feature is three steps and
 * nothing else -- no migration, no billing change, no admin-page change:
 *
 *   1. add one entry here;
 *   2. put `requireFeature("<key>")` on its API routes (apps/api/src/modules/features);
 *   3. check the feature in the app (GET /api/me/features).
 *
 * At API boot the registry is synced into `app.features` (insert-only, never deleted), where the
 * super admin edits each feature's display name and status. Everything else about a feature --
 * who it is for, what it counts, the default monthly limit -- is a code fact and lives only here.
 *
 * Keys are permanent: they are stored in `app.plan_features` and `app.feature_usage_meters`, so a
 * key is never renamed or reused. A retired feature stays in the database and simply leaves this
 * list.
 */

/** Who a feature is sold to. A tier (an `app.plans` row) serves exactly one audience. */
export const FEATURE_AUDIENCES = ["student", "teacher", "parent"] as const;
export type FeatureAudience = (typeof FEATURE_AUDIENCES)[number];

/** What one unit of metered usage is. `null` on a feature means it is not metered. */
export const FEATURE_USAGE_UNITS = ["messages", "generations", "pages", "submissions"] as const;
export type FeatureUsageUnit = (typeof FEATURE_USAGE_UNITS)[number];

export interface FeatureDefinition {
  audience: FeatureAudience;
  /** The usage unit, or `null` for a feature with nothing to count. */
  unit: FeatureUsageUnit | null;
  /**
   * The monthly usage limit a tier gets when it includes the feature without stating its own (a
   * tier with `includes_all_features` picking up a feature added after the tier was defined).
   * `null` is unlimited. A tier's `app.plan_features.monthly_limit` overrides it.
   */
  defaultMonthlyLimit: number | null;
  /** The i18n key of the feature's display name, resolved by the web and mobile apps. */
  nameKey: string;
  /** Not built yet: registered so tiers and licenses can already include it. */
  planned?: true;
}

export const FEATURES = {
  /** The AI tutor: answers grounded in the student's own materials (ask, generate, search). */
  ai_tutor: {
    audience: "student",
    unit: "messages",
    defaultMonthlyLimit: 300,
    nameKey: "features.ai_tutor.name",
  },
  /** Flashcards, quizzes, exam prep, explanations, summaries and key concepts. */
  study_tools: {
    audience: "student",
    unit: "generations",
    defaultMonthlyLimit: 100,
    nameKey: "features.study_tools.name",
  },
  /** Turns lessons and material into an organised notebook. */
  notebook: {
    audience: "student",
    unit: "pages",
    defaultMonthlyLimit: 50,
    nameKey: "features.notebook.name",
    planned: true,
  },
  /** Grades submissions, quizzes and exams for the teacher. */
  auto_grading: {
    audience: "teacher",
    unit: "submissions",
    defaultMonthlyLimit: 500,
    nameKey: "features.auto_grading.name",
    planned: true,
  },
  /** Analysis and data across all of a parent's linked children at the school. */
  family_plus: {
    audience: "parent",
    unit: null,
    defaultMonthlyLimit: null,
    nameKey: "features.family_plus.name",
    planned: true,
  },
} as const satisfies Record<string, FeatureDefinition>;

export type FeatureKey = keyof typeof FEATURES;

/** Every registered key, in registry order. */
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

/**
 * Matches `ck_features_key` in the database: lower snake case, 2-50 characters. Checked by the
 * registry test so a key that the database would refuse fails CI rather than the boot-time sync.
 */
export const FEATURE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;

export function isFeatureKey(value: string): value is FeatureKey {
  return Object.hasOwn(FEATURES, value);
}
