import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/update/app_version.dart';
import 'package:studafy_mobile/src/core/update/release_config.dart';
import 'package:studafy_mobile/src/core/update/update_status.dart';

PlatformRelease _release({required String floor, required String latest}) {
  return PlatformRelease(
    minimumSupported: AppVersion.parse(floor),
    latest: AppVersion.parse(latest),
  );
}

void main() {
  group('evaluateUpdateStatus', () {
    test('below the floor is updateRequired', () {
      final status = evaluateUpdateStatus(
        current: AppVersion.parse('1.1.9'),
        release: _release(floor: '1.2.0', latest: '1.5.0'),
      );

      expect(status, UpdateStatus.updateRequired);
    });

    test('exactly at the floor is not required', () {
      final status = evaluateUpdateStatus(
        current: AppVersion.parse('1.2.0'),
        release: _release(floor: '1.2.0', latest: '1.5.0'),
      );

      expect(status, UpdateStatus.updateAvailable);
    });

    test('between the floor and latest is updateAvailable', () {
      final status = evaluateUpdateStatus(
        current: AppVersion.parse('1.4.0'),
        release: _release(floor: '1.2.0', latest: '1.5.0'),
      );

      expect(status, UpdateStatus.updateAvailable);
    });

    test('at or above latest is upToDate', () {
      expect(
        evaluateUpdateStatus(
          current: AppVersion.parse('1.5.0'),
          release: _release(floor: '1.2.0', latest: '1.5.0'),
        ),
        UpdateStatus.upToDate,
      );
      expect(
        evaluateUpdateStatus(
          current: AppVersion.parse('1.6.0'),
          release: _release(floor: '1.2.0', latest: '1.5.0'),
        ),
        UpdateStatus.upToDate,
      );
    });

    test('an unset (0.0.0) floor never forces an update', () {
      final status = evaluateUpdateStatus(
        current: AppVersion.parse('1.0.0'),
        release: _release(floor: '0.0.0', latest: '0.0.0'),
      );

      expect(status, UpdateStatus.upToDate);
    });
  });

  group('ReleaseConfig.fromJson', () {
    test('parses both platforms and selects by platform', () {
      final config = ReleaseConfig.fromJson({
        'ios': {'minimum_supported_version': '1.2.0', 'latest_version': '1.5.1'},
        'android': {'minimum_supported_version': '1.3.0', 'latest_version': '1.5.0'},
      });

      expect(config.forPlatform(MobilePlatform.ios).minimumSupported,
          AppVersion.parse('1.2.0'));
      expect(config.forPlatform(MobilePlatform.android).latest,
          AppVersion.parse('1.5.0'));
    });
  });
}
