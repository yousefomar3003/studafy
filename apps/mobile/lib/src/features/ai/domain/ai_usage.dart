/// The signed-in student's AI quota for the current billing period, off `GET /api/ai/usage`.
///
/// Only present in [AiHubSubscribed] — the endpoint answers `402`/`403` instead of `200` for
/// every non-entitled caller (see `entitlement-gate.ts`'s `assertAiEntitled`), so by the time this
/// exists the add-on is known active. `active`/`periodStart` from the wire response are dropped
/// here as redundant with that guarantee — this is what the hub screen renders, not a mirror of
/// the response body.
class AiUsage {
  const AiUsage({
    required this.budget,
    required this.usedTokens,
    required this.heldTokens,
    required this.remaining,
    required this.periodEnd,
  });

  /// Monthly token budget for this billing period.
  final int budget;

  /// Tokens the period has already consumed.
  final int usedTokens;

  /// Tokens held by an in-flight request.
  final int heldTokens;

  /// Budget not yet used or held.
  final int remaining;

  /// When the current billing period ends and the budget resets.
  final DateTime periodEnd;

  /// Fraction of [budget] already spent or held, for a progress meter. Clamped to `[0, 1]` —
  /// `heldTokens` can transiently push `usedTokens + heldTokens` a hair past `budget` between a
  /// reservation and its commit — and guarded against `budget == 0` even though every shipped
  /// plan today prices the add-on with a positive budget, since a zero-budget preview tier is a
  /// plausible future plan this getter shouldn't need to change for.
  double get usedFraction {
    if (budget <= 0) return 0;
    return ((usedTokens + heldTokens) / budget).clamp(0, 1).toDouble();
  }
}
