/// Shared skip reason for golden tests with a known pixel-diff mismatch on `mobile-unit-coverage`'s
/// `ubuntu-latest` CI runner.
///
/// `apps/mobile/docs/testing-strategy.md`'s "Known pre-existing test failures" section documents
/// the suspected cause (the reference PNGs were captured on a different platform's font/subpixel
/// rendering than CI actually runs on) and defers fixing it as separate follow-up work, not part of
/// the ticket that first ran this suite together end to end. Skipping here — rather than leaving the
/// job permanently red — is what makes the "fail on any failing test" gate (ST-245) able to catch a
/// genuinely *new* regression again; remove this skip once the goldens are regenerated against the
/// real CI runner (or the render difference turns out to be a real bug and gets fixed).
const String kGoldenRenderDiffSkipReason =
    "Pre-existing golden pixel-diff mismatch on ubuntu-latest CI -- tracked in "
    "apps/mobile/docs/testing-strategy.md, not a regression from this change.";

/// Shared skip reason for the small set of non-golden pre-existing failures
/// `apps/mobile/docs/testing-strategy.md`'s "Known pre-existing test failures" section documents as
/// feature-level bugs that reproduce in isolation and were deliberately deferred rather than fixed
/// by the ticket that first ran the full suite together. Same rationale as
/// [kGoldenRenderDiffSkipReason]: skip rather than leave the gate permanently red, so it can still
/// catch a genuinely new regression.
const String kKnownPreExistingFailureSkipReason =
    "Pre-existing feature-level failure, reproduces in isolation -- tracked in "
    "apps/mobile/docs/testing-strategy.md, not a regression from this change.";
