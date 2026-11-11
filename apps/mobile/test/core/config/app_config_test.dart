import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/config/app_config.dart';
import 'package:studafy_mobile/src/core/config/app_environment.dart';

void main() {
  group('AppConfig.realtimeEnabled', () {
    // Live updates are deferred: a build without --dart-define=REALTIME_ENABLED=true must never
    // open the realtime socket (it would wake the scaled-to-zero gateway on every app open).
    test('is off for every flavor unless the build turns it on', () {
      for (final environment in AppEnvironment.values) {
        expect(
          AppConfig.fromEnvironment(environment).realtimeEnabled,
          isFalse,
          reason: environment.name,
        );
      }
    });

    test('survives copyWith', () {
      final config = AppConfig(
        environment: AppEnvironment.dev,
        apiBaseUrl: Uri.parse('http://localhost:3000'),
        realtimeBaseUrl: Uri.parse('ws://localhost:3001'),
        webBaseUrl: Uri.parse('http://localhost:5180'),
        realtimeEnabled: true,
      );
      expect(
        config
            .copyWith(apiBaseUrl: Uri.parse('http://10.255.255.1'))
            .realtimeEnabled,
        isTrue,
      );
    });
  });
}
