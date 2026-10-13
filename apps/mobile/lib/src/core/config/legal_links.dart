// External-browser links to `apps/web`'s legal pages. Both stores list the same URLs (see
// `apps/mobile/store/privacy-labels.md`), so the app and the listings always point at one page.

/// The authenticated `/account/delete` page (`DeleteAccountPage.tsx`), the self-service GDPR
/// erasure request (see `apps/mobile/store/review-checklist.md`'s account-deletion item).
///
/// No query parameters — deletion always targets the caller's own account, resolved server-side
/// from the bearer token on `/account/delete`, not from anything this link carries.
Uri buildAccountDeleteUrl({required Uri webBaseUrl}) {
  return webBaseUrl.replace(path: '/account/delete');
}

/// The public `/privacy` page (`PrivacyPolicyPage.tsx`). No sign-in required, so it is reachable
/// from the login screen as well as the Profile tab.
Uri buildPrivacyPolicyUrl({required Uri webBaseUrl}) {
  return webBaseUrl.replace(path: '/privacy');
}

/// Apple's standard licensed application end user license agreement — the terms of use an App
/// Store subscription purchase screen must link to (App Review Guideline 3.1.2) when the app has
/// no custom EULA of its own in App Store Connect.
final appleStandardEulaUrl = Uri.parse(
  'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/',
);
