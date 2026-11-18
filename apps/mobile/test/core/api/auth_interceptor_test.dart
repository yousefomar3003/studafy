import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/auth_interceptor.dart';

/// Rejects any request whose bearer isn't [validToken] with a 401; records every bearer seen.
class _TokenCheckingAdapter implements HttpClientAdapter {
  _TokenCheckingAdapter(this.validToken);

  String validToken;
  final bearers = <String?>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final bearer = options.headers['Authorization'] as String?;
    bearers.add(bearer);
    final ok = bearer == 'Bearer $validToken';
    return ResponseBody.fromString(
      jsonEncode(ok ? {'ok': true} : {'title': 'Unauthorized'}),
      ok ? 200 : 401,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  late Dio dio;
  late _TokenCheckingAdapter adapter;
  late String currentToken;
  late int renewals;

  void build({required Future<bool> Function() onUnauthorized}) {
    dio = Dio(BaseOptions(baseUrl: 'http://localhost'));
    adapter = _TokenCheckingAdapter('new-token');
    dio.httpClientAdapter = adapter;
    dio.interceptors.add(
      AuthInterceptor(
        () async => currentToken,
        onUnauthorized: onUnauthorized,
        retryClient: dio,
      ),
    );
  }

  setUp(() {
    currentToken = 'expired-token';
    renewals = 0;
  });

  test(
    'a 401 renews the session once and replays the request with the new token',
    () async {
      build(
        onUnauthorized: () async {
          renewals++;
          currentToken = 'new-token';
          return true;
        },
      );

      final response = await dio.get<Map<String, dynamic>>('/api/students/me');

      expect(response.statusCode, 200);
      expect(renewals, 1);
      expect(adapter.bearers, ['Bearer expired-token', 'Bearer new-token']);
    },
  );

  test('a failed renewal passes the 401 on without retrying', () async {
    build(
      onUnauthorized: () async {
        renewals++;
        return false;
      },
    );

    await expectLater(
      dio.get<dynamic>('/api/students/me'),
      throwsA(
        isA<DioException>().having(
          (e) => e.response?.statusCode,
          'status',
          401,
        ),
      ),
    );
    expect(renewals, 1);
    expect(adapter.bearers, ['Bearer expired-token']);
  });

  test(
    'a request that is rejected again after renewal is not retried a second time',
    () async {
      build(
        onUnauthorized: () async {
          renewals++;
          currentToken = 'still-wrong';
          return true;
        },
      );

      await expectLater(
        dio.get<dynamic>('/api/students/me'),
        throwsA(isA<DioException>()),
      );
      expect(renewals, 1);
      expect(adapter.bearers, ['Bearer expired-token', 'Bearer still-wrong']);
    },
  );

  test('without a recovery callback a 401 passes straight through', () async {
    dio = Dio(BaseOptions(baseUrl: 'http://localhost'));
    adapter = _TokenCheckingAdapter('new-token');
    dio.httpClientAdapter = adapter;
    dio.interceptors.add(AuthInterceptor(() async => currentToken));

    await expectLater(
      dio.get<dynamic>('/api/students/me'),
      throwsA(isA<DioException>()),
    );
    expect(adapter.bearers, ['Bearer expired-token']);
  });

  // QA-084: the bearer token goes only to the API this Dio was built for. An
  // absolute URL on any other host (a pre-signed storage URL, a redirect, a
  // link in content) gets no Authorization.
  group('host scoping', () {
    Future<void> getIgnoringErrors(String url) async {
      try {
        await dio.get<dynamic>(url);
      } on DioException {
        // The adapter answers 401 to a missing bearer; only the header matters.
      }
    }

    setUp(() {
      currentToken = 'new-token';
      dio = Dio(BaseOptions(baseUrl: 'https://api.studafy.test'));
      adapter = _TokenCheckingAdapter('new-token');
      dio.httpClientAdapter = adapter;
      dio.interceptors.add(AuthInterceptor(() async => currentToken));
    });

    test('a relative path on the API gets the bearer', () async {
      await dio.get<dynamic>('/api/students/me');
      expect(adapter.bearers, ['Bearer new-token']);
    });

    test('an absolute URL on the API host gets the bearer', () async {
      await dio.get<dynamic>('https://api.studafy.test/api/students/me');
      expect(adapter.bearers, ['Bearer new-token']);
    });

    test('another origin gets no bearer', () async {
      for (final url in [
        'https://storage.example.com/object?sig=1',
        'https://api.studafy.test.evil.com/x',
        'http://api.studafy.test/api/students/me',
        'https://api.studafy.test:8443/api/students/me',
      ]) {
        await getIgnoringErrors(url);
      }
      expect(adapter.bearers, [null, null, null, null]);
    });

    test('a Dio with no base URL never sends the bearer', () async {
      dio = Dio();
      dio.httpClientAdapter = adapter;
      dio.interceptors.add(AuthInterceptor(() async => currentToken));
      await getIgnoringErrors('https://storage.example.com/object');
      expect(adapter.bearers, [null]);
    });
  });
}
