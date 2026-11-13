import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/config/app_environment.dart';
import 'package:studafy_mobile/src/core/monitoring/monitoring_config.dart';

void main() {
  group('sentryEnabled', () {
    test('is false when the DSN is empty', () {
      const config = MonitoringConfig(sentryDsn: '', environment: 'dev', release: 'app@1.0.0+1');
      expect(config.sentryEnabled, isFalse);
    });

    test('is true once a DSN is supplied', () {
      const config = MonitoringConfig(
        sentryDsn: 'https://key@sentry.example.com/1',
        environment: 'prod',
        release: 'app@1.0.0+1',
      );
      expect(config.sentryEnabled, isTrue);
    });
  });

  group('fromEnvironment', () {
    test('carries the environment short name and given release through', () {
      final config = MonitoringConfig.fromEnvironment(
        AppEnvironment.staging,
        release: 'com.studafy.studafy_mobile@1.0.0+1',
      );

      expect(config.environment, 'staging');
      expect(config.release, 'com.studafy.studafy_mobile@1.0.0+1');
    });

    test('the DSN is empty by default, since SENTRY_DSN is not defined for `flutter test`', () {
      final config = MonitoringConfig.fromEnvironment(AppEnvironment.dev, release: 'app@1.0.0+1');

      expect(config.sentryDsn, isEmpty);
      expect(config.sentryEnabled, isFalse);
    });
  });
}
