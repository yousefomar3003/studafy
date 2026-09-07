import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/update/app_version.dart';

void main() {
  group('AppVersion.parse', () {
    test('reads major.minor.patch', () {
      final version = AppVersion.parse('1.4.2');

      expect(version.major, 1);
      expect(version.minor, 4);
      expect(version.patch, 2);
    });

    test('drops a +build suffix', () {
      expect(AppVersion.parse('1.4.2+87'), AppVersion.parse('1.4.2'));
    });

    test('drops a -prerelease suffix', () {
      expect(AppVersion.parse('2.0.0-rc.1'), AppVersion.parse('2.0.0'));
    });

    test('trims surrounding whitespace', () {
      expect(AppVersion.parse('  1.0.0 '), AppVersion.parse('1.0.0'));
    });

    test('throws on a two-segment version', () {
      expect(() => AppVersion.parse('1.4'), throwsFormatException);
    });

    test('throws on a non-numeric segment', () {
      expect(() => AppVersion.parse('1.x.0'), throwsFormatException);
    });

    test('tryParse returns null instead of throwing', () {
      expect(AppVersion.tryParse('not-a-version'), isNull);
      expect(AppVersion.tryParse('1.2.3'), AppVersion.parse('1.2.3'));
    });
  });

  group('ordering', () {
    test('compares by major, then minor, then patch', () {
      expect(AppVersion.parse('1.0.0') < AppVersion.parse('2.0.0'), isTrue);
      expect(AppVersion.parse('1.2.0') < AppVersion.parse('1.10.0'), isTrue);
      expect(AppVersion.parse('1.2.3') < AppVersion.parse('1.2.4'), isTrue);
      expect(AppVersion.parse('1.2.3') > AppVersion.parse('1.2.0'), isTrue);
    });

    test('equal versions are neither less nor greater', () {
      final a = AppVersion.parse('1.2.3');
      final b = AppVersion.parse('1.2.3');

      expect(a < b, isFalse);
      expect(a > b, isFalse);
      expect(a, b);
      expect(a.hashCode, b.hashCode);
    });

    test('sorts a list ascending', () {
      final versions = [
        AppVersion.parse('1.2.0'),
        AppVersion.parse('1.0.5'),
        AppVersion.parse('2.0.0'),
        AppVersion.parse('1.10.0'),
      ]..sort();

      expect(versions.map((v) => v.toString()).toList(), [
        '1.0.5',
        '1.2.0',
        '1.10.0',
        '2.0.0',
      ]);
    });
  });
}
