import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/kit/kit.dart';

void main() {
  group('SubjectVisuals.of', () {
    test('a course name and its class code get the same visual', () {
      final byName = SubjectVisuals.of('Mathematics');
      expect(byName.icon, Icons.calculate_outlined);
      expect(SubjectVisuals.of('MATH101-A'), byName);
      expect(SubjectVisuals.of('Further Maths'), byName);
    });

    test('Arabic names match, with or without the definite article', () {
      final maths = SubjectVisuals.of('Mathematics');
      expect(SubjectVisuals.of('رياضيات'), maths);
      expect(SubjectVisuals.of('الرياضيات'), maths);
      expect(SubjectVisuals.of('الفيزياء'), SubjectVisuals.of('Physics'));
      expect(SubjectVisuals.of('اللغة العربية'), SubjectVisuals.of('Arabic'));
    });

    test('physical education is sport, not physics', () {
      final pe = SubjectVisuals.of('Physical Education');
      expect(pe.icon, Icons.sports_soccer_outlined);
      expect(pe, isNot(SubjectVisuals.of('Physics')));
      expect(SubjectVisuals.of('PE'), pe);
      expect(SubjectVisuals.of('التربية الرياضية'), pe);
      expect(SubjectVisuals.of('رياضيات'), isNot(pe));
    });

    test('short keywords only match whole words', () {
      // "it" must not turn "Literature" into a computing subject.
      expect(SubjectVisuals.of('Literature').icon, Icons.menu_book_outlined);
      expect(SubjectVisuals.of('IT').icon, Icons.computer_outlined);
    });

    test('an Arabic word that merely contains a keyword is not matched', () {
      // "مدينة" (city) contains "دين" (religion) but is not religious studies.
      expect(SubjectVisuals.of('مدينة').icon, SubjectVisuals.fallbackIcon);
    });

    test(
      'an unknown subject gets a stable hashed accent and the generic icon',
      () {
        final first = SubjectVisuals.of('Homeroom');
        final again = SubjectVisuals.of('homeroom');
        expect(first.icon, SubjectVisuals.fallbackIcon);
        expect(again, first);
        expect(AppAccent.subjectHues, contains(first.accent));
      },
    );

    test('an empty name falls back to the key', () {
      final visual = SubjectVisuals.of(null, fallbackKey: 'class-42');
      expect(visual.accent, SubjectVisuals.accentForKey('class-42'));
      expect(SubjectVisuals.of('', fallbackKey: 'class-42'), visual);
    });

    test('accentForKey spreads keys across several hues', () {
      final hues = {
        for (var i = 0; i < 40; i++) SubjectVisuals.accentForKey('class-$i'),
      };
      expect(hues.length, greaterThan(5));
    });
  });
}
