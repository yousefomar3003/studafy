import 'dart:convert';

/// Decodes the payload segment of a JWT without verifying its signature.
///
/// The server is the source of truth for token validity; this is only ever used for
/// client-side heuristics (a "refresh soon" expiry check, reading the `roles` claim for
/// routing) — never an authorization decision. Returns `null` for a malformed token or any
/// decode failure, which callers should treat the same as "unknown yet".
Map<String, dynamic>? decodeJwtPayload(String jwt) {
  try {
    final parts = jwt.split('.');
    if (parts.length != 3) return null;

    final payload = utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
    return jsonDecode(payload) as Map<String, dynamic>;
  } catch (_) {
    return null;
  }
}
