import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/config/provider_retry_policy.dart';

DioException _httpError(int status, {bool mapped = true}) {
  final requestOptions = RequestOptions(path: '/api/x');
  final response = Response<dynamic>(
    requestOptions: requestOptions,
    statusCode: status,
  );
  return DioException(
    requestOptions: requestOptions,
    response: response,
    type: DioExceptionType.badResponse,
    error: mapped ? ApiException(status: status, title: 'failed') : null,
  );
}

void main() {
  group('providerRetryPolicy', () {
    for (final status in [400, 401, 402, 403, 404, 409, 422, 429]) {
      test('never retries a $status', () {
        expect(providerRetryPolicy(0, _httpError(status)), isNull);
        expect(
          providerRetryPolicy(0, _httpError(status, mapped: false)),
          isNull,
        );
        expect(
          providerRetryPolicy(0, ApiException(status: status, title: 'failed')),
          isNull,
        );
      });
    }

    test(
      'retries 5xx and connection failures with a doubling backoff, then gives up',
      () {
        final errors = [
          _httpError(500),
          _httpError(503),
          DioException.connectionError(
            requestOptions: RequestOptions(path: '/api/x'),
            reason: 'offline',
          ),
          TimeoutException('slow'),
        ];
        for (final error in errors) {
          expect(
            providerRetryPolicy(0, error),
            const Duration(milliseconds: 500),
          );
          expect(providerRetryPolicy(1, error), const Duration(seconds: 1));
          expect(providerRetryPolicy(2, error), const Duration(seconds: 2));
          expect(providerRetryPolicy(providerMaxRetries, error), isNull);
        }
      },
    );

    test('never retries a programming error', () {
      expect(providerRetryPolicy(0, StateError('bug')), isNull);
    });
  });

  test(
    'a provider failing with a 4xx settles into AsyncError immediately, not loading',
    () async {
      var calls = 0;
      final provider = FutureProvider<int>((ref) async {
        calls++;
        throw _httpError(403);
      });
      final container = ProviderContainer(retry: providerRetryPolicy);
      addTearDown(container.dispose);
      container.listen(provider, (_, _) {});

      await expectLater(
        container.read(provider.future),
        throwsA(isA<DioException>()),
      );
      await Future<void>.delayed(const Duration(milliseconds: 50));

      final state = container.read(provider);
      expect(state.hasError, isTrue);
      expect(state.isLoading, isFalse);
      expect(calls, 1);
    },
  );
}
