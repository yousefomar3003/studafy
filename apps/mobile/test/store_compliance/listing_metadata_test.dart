import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Store listing field limits (ST-310) — see `store/listing-metadata.md`.
///
/// Both consoles refuse an over-limit field outright. The copy is pasted by hand, so the limit is
/// checked here, against the quoted text under each heading.
void main() {
  final listing = File('store/listing-metadata.md').readAsStringSync();

  test('the App Store subtitle fits in 30 characters', () {
    expect(_quoted(listing, '## Subtitle').length, lessThanOrEqualTo(30));
  });

  test('the Play short description fits in 80 characters', () {
    expect(_quoted(listing, '## Short description').length, lessThanOrEqualTo(80));
  });

  test('the App Store keyword field fits in 100 characters, with no repeats or spaces', () {
    final keywords = _quoted(listing, '## Keywords');
    final terms = keywords.split(',');

    expect(keywords.length, lessThanOrEqualTo(100));
    expect(keywords, isNot(contains(' ')));
    expect(terms.toSet().length, terms.length);
  });

  test('the full description fits in 4,000 characters', () {
    final section = _section(listing, '## Full description');
    final description = [
      for (final line in section.split('\n'))
        if (line.startsWith('>')) line.substring(1).trim(),
    ].join('\n');

    expect(description, isNotEmpty);
    expect(description.length, lessThanOrEqualTo(4000));
  });
}

/// The text of the section starting at [heading], up to the next `## ` heading.
String _section(String markdown, String heading) {
  final start = markdown.indexOf(heading);
  expect(start, isNot(-1), reason: '$heading not found');
  final next = markdown.indexOf('\n## ', start + heading.length);
  return markdown.substring(start, next == -1 ? markdown.length : next);
}

/// The single `> ` quoted line in the section starting at [heading].
String _quoted(String markdown, String heading) {
  final quotes = [
    for (final line in _section(markdown, heading).split('\n'))
      if (line.startsWith('> ')) line.substring(2).trim(),
  ];
  expect(quotes, hasLength(1), reason: heading);
  return quotes.single;
}
