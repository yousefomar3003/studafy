/// Builds the external-browser deep link for the AI add-on's website checkout —
/// `apps/web`'s `AiSubscriptionPurchasePage` at `/account/ai` (ST-208), reached via
/// `apps/web/src/app/routes.tsx`'s `account/ai` route. That page is the only place a purchase can
/// actually happen; see `apps/mobile/docs/ai_store_compliance.md` (R-07) for why this app never
/// shows purchase UI of its own.
///
/// `studentId` and `priceId` are both required by the destination page — it renders a "link is
/// missing information" notice instead of the purchase flow otherwise (see that page's own doc
/// comment) — so this returns `null` rather than a link the page would reject when either input
/// isn't available: `studentId` from the signed-in session
/// (`../application/student_context_providers.dart`'s `currentStudentIdProvider`, a known gap),
/// `aiAddonPriceId` from [AppConfig] (`../../../core/config/app_config.dart`).
Uri? buildAiCheckoutUrl({
  required Uri webBaseUrl,
  required String? studentId,
  required String aiAddonPriceId,
}) {
  if (studentId == null || studentId.isEmpty || aiAddonPriceId.isEmpty) return null;

  return webBaseUrl.replace(
    path: '/account/ai',
    queryParameters: {'studentId': studentId, 'priceId': aiAddonPriceId},
  );
}
