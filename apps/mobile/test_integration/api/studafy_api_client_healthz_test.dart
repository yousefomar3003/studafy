import 'dart:io';

import 'package:studafy_mobile/src/core/api/api_client.dart';
import 'package:studafy_mobile/src/core/api/generated/models/health_ok_status.dart';
import 'package:test/test.dart';

/// A real integration test (ST-062): calls a live API process over a real socket, deserializes
/// the response through the generated client, and asserts on the typed result. Deliberately not
/// run via `flutter test` — `TestWidgetsFlutterBinding` replaces `HttpClient` process-wide with a
/// fake that returns 400 to every request (to keep ordinary widget/unit tests from making
/// accidental network calls), and forcing a real `HttpClient` back in via `HttpOverrides.runZoned`
/// deadlocks Dio inside that binding's zone (a stack overflow in `DioMixin.fetch`, reproduced
/// while building this test). A plain `dart test` process never installs that binding, so this
/// file lives in `test_integration/`, outside `test/`, and is run separately — see
/// `scripts/generate_api_client.sh` and `package.json`'s `test:integration` script.
///
/// `API_BASE_URL` is a real process environment variable (not a `--dart-define`, since `dart test`
/// has no equivalent flag) pointing at a running API instance. Empty/unset skips this test — there
/// is no live API to call. CI's `mobile-api-client` job starts one on a fixed port with no
/// `DATABASE_HOST` (the liveness probe checks no dependency — see `apps/api/src/db/client.ts` —
/// so no database or Redis is needed) and sets this env var; to run locally, do the same and set
/// it yourself.
void main() {
  final apiBaseUrl = Platform.environment['API_BASE_URL'];

  test(
    'GET /healthz reaches the live API through the generated client',
    () async {
      final api = createApiClient(baseUrl: Uri.parse(apiBaseUrl!));

      final health = await api.health.getLiveness();

      expect(health.status, HealthOkStatus.ok);
    },
    skip: apiBaseUrl == null || apiBaseUrl.isEmpty
        ? 'No live API: set API_BASE_URL=http://host:port to run this test.'
        : false,
  );
}
