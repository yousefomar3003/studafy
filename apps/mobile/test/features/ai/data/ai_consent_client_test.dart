import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_consent_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_consent.dart';

/// Answers every request with [body] and records what was sent.
class _JsonAdapter implements HttpClientAdapter {
  _JsonAdapter(this.body);

  final Map<String, dynamic> body;
  final requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    return ResponseBody.fromString(
      jsonEncode(body),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

Map<String, dynamic> _body({Map<String, dynamic>? consent}) => {
  'disclosure': {
    'version': '2026-09-28',
    'provider': {
      'id': 'anthropic',
      'name': 'Anthropic',
      'privacyPolicyUrl': 'https://www.anthropic.com/legal/privacy',
    },
    'dataCategories': ['questions', 'study_materials', 'account_identifier', 'a_future_category'],
  },
  'consent': consent,
};

(AiConsentClient, _JsonAdapter) _client(Map<String, dynamic> body) {
  final adapter = _JsonAdapter(body);
  return (AiConsentClient(Dio()..httpClientAdapter = adapter), adapter);
}

void main() {
  test('parses the disclosure, skipping categories this build does not know', () async {
    final (client, _) = _client(_body());

    final status = await client.status();

    expect(status.isGranted, isFalse);
    expect(status.disclosure.version, '2026-09-28');
    expect(status.disclosure.providerName, 'Anthropic');
    expect(
      status.disclosure.privacyPolicyUrl,
      Uri.parse('https://www.anthropic.com/legal/privacy'),
    );
    expect(status.disclosure.dataCategories, AiDataCategory.values);
  });

  test('grant sends the shown version and parses the recorded consent', () async {
    final (client, adapter) = _client(
      _body(consent: {'id': 'c1', 'grantedAt': '2026-09-28T10:00:00.000Z'}),
    );

    final status = await client.grant('2026-09-28');

    expect(adapter.requests.single.method, 'PUT');
    expect(adapter.requests.single.path, '/api/ai/consent');
    expect(adapter.requests.single.data, {'disclosureVersion': '2026-09-28'});
    expect(status.grantedAt, DateTime.utc(2026, 9, 28, 10));
  });

  test('withdraw issues a DELETE', () async {
    final (client, adapter) = _client(_body());

    final status = await client.withdraw();

    expect(adapter.requests.single.method, 'DELETE');
    expect(status.isGranted, isFalse);
  });
}
