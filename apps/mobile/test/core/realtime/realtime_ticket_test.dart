import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/realtime/realtime_ticket.dart';

/// Answers every request with [status] and [body], recording the request it saw.
class _StubAdapter implements HttpClientAdapter {
  _StubAdapter(this.status, [this.body = '{}']);

  final int status;
  final String body;
  RequestOptions? seen;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    seen = options;
    return ResponseBody.fromString(
      body,
      status,
      headers: {
        Headers.contentTypeHeader: ['application/json'],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

Dio _dio(_StubAdapter adapter) =>
    Dio(BaseOptions(baseUrl: 'https://api.studafy.test'))
      ..httpClientAdapter = adapter;

void main() {
  test('asks the API for a ticket and returns it', () async {
    final adapter = _StubAdapter(
      200,
      '{"ticket":"t.i.cket","expires_at":"2026-11-03T12:00:30.000Z"}',
    );

    expect(await realtimeTicketProvider(_dio(adapter))(), 't.i.cket');
    expect(adapter.seen!.path, '/api/realtime/ticket');
    expect(adapter.seen!.method, 'GET');
  });

  for (final status in [401, 403]) {
    test('resolves null when the API refuses the session ($status)', () async {
      expect(
        await realtimeTicketProvider(_dio(_StubAdapter(status)))(),
        isNull,
      );
    });
  }

  test('throws on a server error, so the client retries', () async {
    await expectLater(
      realtimeTicketProvider(_dio(_StubAdapter(503)))(),
      throwsA(isA<DioException>()),
    );
  });

  test('throws on a response without a ticket', () async {
    await expectLater(
      realtimeTicketProvider(_dio(_StubAdapter(200)))(),
      throwsA(isA<StateError>()),
    );
  });
}
