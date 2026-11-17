import 'package:flutter/services.dart';

/// Reads a number typed on any of the keyboards the app supports: Western digits, Arabic-Indic
/// (٠-٩) and Eastern Arabic-Indic (۰-۹) digits, with `.`, `,` or the Arabic decimal separator
/// `٫` as the decimal point. Surrounding whitespace is ignored. Null when it isn't a number.
num? parseLocalizedNumber(String? raw) {
  final normalized = StringBuffer();
  for (final rune in (raw ?? '').trim().runes) {
    if (rune >= 0x0660 && rune <= 0x0669) {
      normalized.writeCharCode(0x30 + rune - 0x0660);
    } else if (rune >= 0x06F0 && rune <= 0x06F9) {
      normalized.writeCharCode(0x30 + rune - 0x06F0);
    } else if (rune == 0x066B || rune == 0x2C) {
      normalized.write('.');
    } else {
      normalized.writeCharCode(rune);
    }
  }
  return num.tryParse(normalized.toString());
}

/// Lets through only what [parseLocalizedNumber] understands: the three digit sets and the
/// three decimal separators. For a decimal number field whose keyboard may be Arabic.
final localizedDecimalInputFormatter = FilteringTextInputFormatter.allow(
  RegExp('[0-9٠-٩۰-۹.,٫]'),
);
