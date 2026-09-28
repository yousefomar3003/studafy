import 'package:dio/dio.dart';

import '../domain/ai_consent.dart';

/// Client for the consent store behind `/api/ai/consent` (ST-305): read the disclosure and the
/// caller's consent, grant it, withdraw it. Every call answers with the same status body.
///
/// Hand-written for the same reason as [AiHubClient]: the `AI` tag is excluded from the mobile
/// OpenAPI codegen (see `pubspec.yaml`'s `swagger_parser.exclude_tags`). The injected [Dio]
/// carries the shared `ErrorMappingInterceptor`, so a non-2xx body surfaces as an `ApiException`
/// on the thrown [DioException].
class AiConsentClient {
  AiConsentClient(this._dio);

  final Dio _dio;

  static const _path = '/api/ai/consent';

  Future<AiConsentStatus> status() async =>
      _parse((await _dio.get<Map<String, dynamic>>(_path)).data);

  /// Records consent to the disclosure [version] the user was shown. A `409
  /// AI_CONSENT_DISCLOSURE_OUTDATED` means the server now serves a newer disclosure.
  Future<AiConsentStatus> grant(String version) async => _parse(
    (await _dio.put<Map<String, dynamic>>(_path, data: {'disclosureVersion': version})).data,
  );

  Future<AiConsentStatus> withdraw() async =>
      _parse((await _dio.delete<Map<String, dynamic>>(_path)).data);

  static AiConsentStatus _parse(Map<String, dynamic>? body) {
    final disclosure = body?['disclosure'] as Map<String, dynamic>? ?? const {};
    final provider = disclosure['provider'] as Map<String, dynamic>? ?? const {};
    final consent = body?['consent'] as Map<String, dynamic>?;

    return AiConsentStatus(
      disclosure: AiDataSharingDisclosure(
        version: disclosure['version'] as String? ?? '',
        providerName: provider['name'] as String? ?? '',
        privacyPolicyUrl: Uri.tryParse(provider['privacyPolicyUrl'] as String? ?? ''),
        dataCategories: [
          for (final name in disclosure['dataCategories'] as List<dynamic>? ?? const [])
            ?AiDataCategory.fromWire(name as String),
        ],
      ),
      grantedAt: DateTime.tryParse(consent?['grantedAt'] as String? ?? ''),
    );
  }
}
