/// Builds the external-browser deep link for account deletion — `apps/web`'s authenticated
/// `/account/delete` page (`DeleteAccountPage.tsx`), the self-service GDPR erasure request this
/// app previously had no path to at all (see `apps/mobile/store/review-checklist.md`'s
/// account-deletion blocking item).
///
/// No query parameters and no nullable inputs, unlike [buildAiCheckoutUrl]
/// (`ai_checkout_link.dart`) — deletion always targets the caller's own account, resolved
/// server-side from the bearer token on `/account/delete`, not from anything this link carries.
Uri buildAccountDeleteUrl({required Uri webBaseUrl}) {
  return webBaseUrl.replace(path: '/account/delete');
}
