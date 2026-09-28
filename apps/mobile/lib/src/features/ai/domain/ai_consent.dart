/// Third-party AI data-sharing consent (ST-305), mirroring `GET /api/ai/consent`
/// (`apps/api/src/modules/ai/routes/consent-routes.ts`).
///
/// The disclosure — which provider receives the user's AI inputs and which kinds of data those
/// are — is served by the API rather than hard-coded here, so the modal always names exactly what
/// the server will enforce. The server is also the enforcement point: every model-calling
/// `/api/ai/*` route refuses with `403 AI_CONSENT_REQUIRED` until consent is recorded, whatever
/// this app shows.
library;

/// A kind of personal data sent to the model provider. Wire names match the API's
/// `AI_DATA_CATEGORIES` (`apps/api/src/modules/ai/consent/disclosure.ts`).
enum AiDataCategory {
  questions('questions'),
  studyMaterials('study_materials'),
  accountIdentifier('account_identifier');

  const AiDataCategory(this.wireName);

  final String wireName;

  /// Null for a category this build doesn't know yet — the caller keeps the rest instead of
  /// failing, and the server-side version bump that introduced it still re-prompts the user.
  static AiDataCategory? fromWire(String value) {
    for (final category in values) {
      if (category.wireName == value) return category;
    }
    return null;
  }
}

/// What the user is asked to agree to.
class AiDataSharingDisclosure {
  const AiDataSharingDisclosure({
    required this.version,
    required this.providerName,
    required this.privacyPolicyUrl,
    required this.dataCategories,
  });

  /// Echoed back on grant, so the server can refuse consent to a disclosure it no longer serves.
  final String version;
  final String providerName;
  final Uri? privacyPolicyUrl;
  final List<AiDataCategory> dataCategories;
}

/// The disclosure and whether the signed-in user has consented to it.
class AiConsentStatus {
  const AiConsentStatus({required this.disclosure, required this.grantedAt});

  final AiDataSharingDisclosure disclosure;

  /// When consent to [disclosure] was recorded; null means AI features stay locked.
  final DateTime? grantedAt;

  bool get isGranted => grantedAt != null;
}
