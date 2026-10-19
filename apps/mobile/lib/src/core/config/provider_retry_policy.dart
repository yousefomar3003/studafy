import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show ProviderException;

import '../api/api_exception.dart';

/// The most automatic retries a failing provider gets before it settles into its error state.
const providerMaxRetries = 3;

/// The delay before the first retry; each later retry doubles it (500ms, 1s, 2s).
const providerRetryBaseDelay = Duration(milliseconds: 500);

/// The app-wide [Retry] policy for the root `ProviderScope`.
///
/// Riverpod's default ([ProviderContainer.defaultRetry]) retries *any* exception up to 10 times
/// over ~40s, and a provider stays in a loading-with-error state while a retry is pending — so a
/// card driven by `.when(loading: …)` shows its skeleton the whole time instead of its error
/// state. That is pointless for a client error: a 401/402/403/404 (an inactive subscription, a
/// missing permission, a gone resource) answers the same way every time.
///
/// So: never retry a 4xx, never retry a programming [Error] or a [ProviderException] (the
/// failing dependency retries itself — same as the default), and give transient failures (no
/// connection, timeouts, 5xx) a short, bounded backoff.
Duration? providerRetryPolicy(int retryCount, Object error) {
  if (retryCount >= providerMaxRetries) return null;
  if (error is ProviderException || error is Error) return null;
  if (isClientError(error)) return null;
  return providerRetryBaseDelay * (1 << retryCount);
}

/// Whether [error] is an HTTP 4xx — either a bare [ApiException] or a [DioException] carrying
/// one (see `ErrorMappingInterceptor`) or a 4xx response of its own.
bool isClientError(Object error) {
  final status = switch (error) {
    ApiException(:final status) => status,
    DioException(:final ApiException apiError) => apiError.status,
    DioException(:final response?) => response.statusCode,
    _ => null,
  };
  return status != null && status >= 400 && status < 500;
}
