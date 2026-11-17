# ADR-023: The mobile app does not pin TLS certificates

## Status

Proposed (QA-084). Records an accepted risk; it needs the owner's sign-off.

## Context

The QA review (QA-084) found that the Flutter app trusts any certificate the device trusts for the
API host. Someone who can add a CA to a device (a managed school device with an MDM profile, a
corporate proxy, or a user who installs one on purpose) can read and change the app's traffic,
bearer tokens included.

Pinning (accepting only Studafy's own certificate or public key, checked in Dio's
`HttpClient.badCertificateCallback` or a pinning package) closes that path but has costs:

- **Lock-out risk.** A pinned key that changes without a matching app update (an emergency
  certificate reissue, a move to a different CDN, a hosting provider rotating its intermediate)
  breaks every installed copy until users update. Store review can take days, and the forced-update
  check (`config/mobile`) is served by that same API, so it can't rescue a pinned-out app.
- **Hosting.** The API is served by Fly.io with certificates the platform issues and renews
  automatically. Their intermediates and keys rotate on the provider's schedule, not ours.
- **Little gain on the threat that matters.** The data at risk is the user's own. A device whose
  owner (or MDM) installed a CA can already read the app's screen and storage. Pinning mainly stops
  a user from inspecting their own traffic.

Both platforms already require TLS: Android blocks cleartext by default for the app's target SDK
and the app does not opt back in (no `usesCleartextTraffic`, no network security config), and iOS
App Transport Security has no exceptions in `Info.plist`.

## Decision

1. **No certificate or public-key pinning** in the mobile app for now. This is an accepted risk.
2. The mitigations QA-084 added stay in place: the bearer token is attached only to requests to
   the API's own origin (`AuthInterceptor.isApiRequest`), sessions are short-lived and refreshable,
   and tokens live in the platform keystore.
3. **Revisit** if any of these become true: the API moves to certificates we control end to end
   (our own CA or a stable key we can pin with a backup key), a customer contract or regulator
   requires pinning, or the app starts handling payment card data directly.

If pinning is adopted later, pin the SubjectPublicKeyInfo of at least two keys (current and a
backup that is not in use), ship the backup pin before rotating, and add a remote kill switch that
does not depend on the pinned host.

## Consequences

- A device with an added trusted CA can intercept the app's API traffic. This is documented here
  and in the QA evidence for QA-084.
- No release can lock users out through a certificate change.
- Security reviews should treat "no pinning" as a known, accepted item, not a new finding.

## Review

- Proposed by QA remediation (QA-084), 2026-11-17. Awaiting owner sign-off.
