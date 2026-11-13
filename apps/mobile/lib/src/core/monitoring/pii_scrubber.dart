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

/// Redacts PII from crash/breadcrumb payloads before they leave the device.
///
/// Applied at two points: [SentryCrashReporter]'s `beforeSend`/`beforeBreadcrumb` hooks (for
/// data the Sentry SDK collects itself) and [CompositeCrashReporter] (for every manual
/// breadcrumb/error reason passed by app code, fanned out to both backends). Both call the same
/// instance so the redaction rules never drift between them.
class PiiScrubber {
  const PiiScrubber();

  /// Redacts inline email addresses from free text. Structured secrets (tokens, passwords)
  /// belong in a map key, not free text, so [scrubMap] is what catches those.
  String scrubText(String input) => input.replaceAll(_emailPattern, '[redacted-email]');

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
