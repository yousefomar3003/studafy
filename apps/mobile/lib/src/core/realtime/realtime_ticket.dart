import 'package:dio/dio.dart';

import 'realtime_client.dart';

/// Builds the [RealtimeTokenProvider] the app runs with: every connect attempt asks the API for a
/// fresh realtime handshake ticket (`GET /api/realtime/ticket`, QA-14) and hands that to the
/// gateway, so the session's access token never travels in a WebSocket URL. A ticket is single-use
/// and expires 30 seconds after it is minted. See apps/realtime/docs/protocol.md#handshake-ticket.
///
/// [dio] must be the authenticated client (`core/auth/authenticated_dio.dart`): it attaches the
/// bearer token and recovers from an expired one the same way every other API call does.
///
/// Resolves `null` when the API refuses the session (401/403), which the client reports as
/// `unauthorized`. Any other failure throws, and the client retries with backoff.
RealtimeTokenProvider realtimeTicketProvider(Dio dio) {
  return () async {
    try {
      final response = await dio.get<Map<String, dynamic>>(
        '/api/realtime/ticket',
        options: Options(headers: {'Cache-Control': 'no-store'}),
      );
      final ticket = response.data?['ticket'];
      if (ticket is String && ticket.isNotEmpty) {
        return ticket;
      }
      throw StateError('realtime ticket response carried no ticket');
    } on DioException catch (error) {
      final status = error.response?.statusCode;
      if (status == 401 || status == 403) {
        return null;
      }
      rethrow;
    }
  };
}
