import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/localized_number.dart';

void main() {
  group('parseLocalizedNumber', () {
    test('reads Western, Arabic-Indic and Eastern Arabic-Indic digits', () {
      expect(parseLocalizedNumber('25'), 25);
      expect(parseLocalizedNumber('٢٥'), 25);
      expect(parseLocalizedNumber('۲۵'), 25);
    });

    test(
      'takes ., , and ٫ as the decimal point and ignores surrounding space',
      () {
        expect(parseLocalizedNumber(' 2.5 '), 2.5);
        expect(parseLocalizedNumber('2,5'), 2.5);
        expect(parseLocalizedNumber('٢٫٥'), 2.5);
      },
    );

    test('is null for anything that is not a number', () {
      expect(parseLocalizedNumber(null), isNull);
      expect(parseLocalizedNumber(''), isNull);
      expect(parseLocalizedNumber('abc'), isNull);
      expect(parseLocalizedNumber('1.2.3'), isNull);
    });
  });
}
