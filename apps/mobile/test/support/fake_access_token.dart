import 'dart:convert';

/// Builds a syntactically valid, unsigned JWT string carrying the given `roles` claim.
///
/// Only [AuthSession]'s client-side claim decoding is under test here, never signature
/// verification (that's the server's job — see `jwt_payload.dart`), so the signature segment
/// is left empty. Padding is stripped from both segments, matching how real tokens are
/// encoded on the wire, to exercise the same `base64Url.normalize` path production tokens do.
String fakeAccessToken({List<String> roles = const [], DateTime? expiresAt}) {
  final header = _encodeSegment({'alg': 'none', 'typ': 'JWT'});
  final payload = _encodeSegment({
    'sub': 'test-user',
    'roles': roles,
    'exp': (expiresAt ?? DateTime.now().add(const Duration(hours: 1)))
            .millisecondsSinceEpoch ~/
        1000,
  });
  return '$header.$payload.';
}

String _encodeSegment(Map<String, dynamic> claims) {
  return base64Url.encode(utf8.encode(jsonEncode(claims))).replaceAll('=', '');
}
