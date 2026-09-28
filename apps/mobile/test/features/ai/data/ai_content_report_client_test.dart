import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/error_mapping_interceptor.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_content_report_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_content_report.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_study.dart';

/// Answers every request with [status] and a problem+json body when it is an error.
class _StatusAdapter implements HttpClientAdapter {
  _StatusAdapter(this.status);

  final int status;
  final requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final body = status < 300
        ? {'report_id': 'r1', 'priority': 'normal', 'respond_by': '2026-10-01T00:00:00.000Z'}
        : {'status': status, 'title': 'error', 'code': 'AI_ANSWER_REPORTED'};
    return ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [
          status < 300 ? Headers.jsonContentType : 'application/problem+json',
        ],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

(AiContentReportClient, _StatusAdapter) _client(int status) {
  final adapter = _StatusAdapter(status);
  final dio = Dio()
    ..httpClientAdapter = adapter
    ..interceptors.add(ErrorMappingInterceptor());
  return (AiContentReportClient(dio), adapter);
}

void main() {
  test('posts the item identity and reason, never the content itself', () async {
    final (client, adapter) = _client(201);

    final outcome = await client.report(
      studentId: 's1',
      target: const AiReportTarget.quiz('q1'),
      reason: AiReportReason.childSafety,
      details: '  looks wrong  ',
    );

    expect(outcome, AiReportOutcome.filed);
    expect(adapter.requests.single.path, '/api/ai/students/s1/reports');
    expect(adapter.requests.single.data, {
      'content_type': 'quiz',
      'content_id': 'q1',
      'reason_category': 'child_safety',
      'reason': 'looks wrong',
    });
  });

  test('a summary carries its length preset and blank details are omitted', () async {
    final (client, adapter) = _client(201);

    await client.report(
      studentId: 's1',
      target: const AiReportTarget.summary('m1', AiSummaryLength.brief),
      reason: AiReportReason.inaccurate,
      details: '   ',
    );

    expect(adapter.requests.single.data, {
      'content_type': 'summary',
      'content_id': 'm1',
      'summary_length': 'brief',
      'reason_category': 'inaccurate',
    });
  });

  test('409 means already reported; any other failure is failed', () async {
    final (duplicate, _) = _client(409);
    final (missing, _) = _client(404);
    const target = AiReportTarget.flashcardDeck('d1');

    expect(
      await duplicate.report(studentId: 's1', target: target, reason: AiReportReason.other),
      AiReportOutcome.alreadyFiled,
    );
    expect(
      await missing.report(studentId: 's1', target: target, reason: AiReportReason.other),
      AiReportOutcome.failed,
    );
  });
}
