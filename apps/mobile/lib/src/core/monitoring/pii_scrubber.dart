/// Case-insensitive key names redacted wherever they appear in structured breadcrumb/event
/// data — credentials and contact fields carry PII/secrets regardless of which feature attached
/// them, so this list is the single place that decides what never reaches a crash dashboard.
const _sensitiveKeys = {
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'auth',
  'secret',
  'apikey',
  'cookie',
  'email',
  'phone',
  'ssn',
  'sessionid',
};

final _emailPattern = RegExp(r'[\w.+-]+@[\w-]+\.[\w.-]+');

/// `Bearer <token>` in a logged header or message.
final _bearerPattern = RegExp(r'(Bearer\s+)[^\s"\x27,;}\]]+', caseSensitive: false);

/// A JWT (header.payload.signature, base64url): access tokens and ID tokens.
final _jwtPattern = RegExp(r'\beyJ[\w-]*\.[\w-]+\.[\w-]+');

/// Path segments that are a secret because of the segment before them, e.g. the invitation token in
/// `/api/auth/invitations/<token>/oauth/...` (QA-088).
final _secretPathPattern = RegExp(
  r'(/(?:invitations|invitation|invite|activate|activation|reset-password|password-reset|verify-email|deletion-requests)/)[^/?#\s"\x27]+',
  caseSensitive: false,
);

/// URL query parameters whose value is a secret: OAuth codes and state, tokens, and the signature
/// and credential of a pre-signed storage URL.
final _secretQueryPattern = RegExp(
  r'([?&;](?:token|access_token|refresh_token|id_token|code|state|nonce|sig|signature|'
  r'x-amz-signature|x-amz-credential|x-amz-security-token|password|secret|key|session|sessionid)=)'
  r'[^&#\s"\x27]*',
  caseSensitive: false,
);

/// The same query parameters in a bare query string (no leading `?`), as Sentry's
/// `request.query_string` holds it.
final _leadingSecretQueryPattern = RegExp(
  r'^((?:token|access_token|refresh_token|id_token|code|state|nonce|sig|signature|'
  r'x-amz-signature|x-amz-credential|x-amz-security-token|password|secret|key|session|sessionid)=)'
  r'[^&#\s"\x27]*',
  caseSensitive: false,
);

/// Redacts PII from crash/breadcrumb payloads before they leave the device.
///
/// Applied at two points: [SentryCrashReporter]'s `beforeSend`/`beforeBreadcrumb` hooks (for
/// data the Sentry SDK collects itself) and [CompositeCrashReporter] (for every manual
/// breadcrumb/error reason passed by app code, fanned out to both backends). Both call the same
/// instance so the redaction rules never drift between them.
class PiiScrubber {
  const PiiScrubber();

  /// Redacts PII and secrets from free text: email addresses, bearer tokens, JWTs, secret URL path
  /// segments (an invitation token) and secret query parameters (OAuth `code`/`state`, a
  /// pre-signed URL's signature). Exception messages are free text too: Dio puts the failing URL
  /// in them (QA-088). Secrets in structured data are caught by key in [scrubMap].
  String scrubText(String input) => input
      .replaceAll(_emailPattern, '[redacted-email]')
      .replaceAllMapped(_jwtPattern, (_) => '[redacted-jwt]')
      .replaceAllMapped(_bearerPattern, (m) => '${m[1]}[redacted]')
      .replaceAllMapped(_secretPathPattern, (m) => '${m[1]}[redacted]')
      .replaceAllMapped(_secretQueryPattern, (m) => '${m[1]}[redacted]')
      .replaceAllMapped(_leadingSecretQueryPattern, (m) => '${m[1]}[redacted]');

  /// Redacts sensitive keys recursively from structured breadcrumb/event data.
  Map<String, Object?>? scrubMap(Map<String, Object?>? input) {
    if (input == null) return null;
    return input.map((key, value) => MapEntry(key, _scrubValue(key, value)));
  }

  Object? _scrubValue(String key, Object? value) {
    if (_sensitiveKeys.contains(key.toLowerCase())) return '[redacted]';
    if (value is String) return scrubText(value);
    if (value is Map) return scrubMap(Map<String, Object?>.from(value));
    if (value is List) {
      return value.map((entry) => entry is String ? scrubText(entry) : entry).toList();
    }
    return value;
  }
}
