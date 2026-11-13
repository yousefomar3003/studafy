import type { MyFeature, MyFeatures } from "../features/gate";

/** `GET /api/me/features` entries for the paid-feature tests, shaped exactly as the API sends them. */
export function feature(overrides: Partial<MyFeature> = {}): MyFeature {
  return {
    key: "ai_tutor",
    name: "AI tutor",
    nameKey: "features.ai_tutor.name",
    audience: "student",
    unit: "messages",
    active: false,
    source: null,
    sources: [],
    limit: null,
    used: 0,
    periodEnd: null,
    reason: "not_included",
    schoolSeat: false,
    schoolOffers: false,
    renewalStop: null,
    ...overrides,
  };
}

export function grant(
  source: "purchase" | "school_license" | "trial",
  periodEnd = "2027-08-31T00:00:00.000Z",
  limit: number | null = null,
) {
  return { source, tier: "student_plus", limit, periodEnd };
}

export function features(list: MyFeature[]): MyFeatures {
  return { schoolName: "Alpha Academy", features: list };
}
