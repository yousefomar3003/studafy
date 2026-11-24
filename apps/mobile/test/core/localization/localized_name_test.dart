import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/localization/localized_name.dart';
import 'package:studafy_mobile/src/features/student/domain/academic_results.dart';
import 'package:studafy_mobile/src/features/student/domain/transcript.dart';

void main() {
  group('pickLocalizedName', () {
    test(
      'uses the Arabic spelling only in Arabic, and only when there is one',
      () {
        expect(
          pickLocalizedName('ar', 'Mathematics', 'الرياضيات'),
          'الرياضيات',
        );
        expect(
          pickLocalizedName('en', 'Mathematics', 'الرياضيات'),
          'Mathematics',
        );
        expect(pickLocalizedName('ar', 'Science', null), 'Science');
        expect(pickLocalizedName('ar', 'Science', '  '), 'Science');
      },
    );
  });

  group('documentName', () {
    test('follows the issued language, or the reader when there is none', () {
      expect(
        documentName(DocumentLanguage.ar, 'en', 'Grade 9', 'الصف التاسع'),
        'الصف التاسع',
      );
      expect(
        documentName(DocumentLanguage.en, 'ar', 'Grade 9', 'الصف التاسع'),
        'Grade 9',
      );
      expect(
        documentName(
          DocumentLanguage.bilingual,
          'en',
          'Grade 9',
          'الصف التاسع',
        ),
        'Grade 9 / الصف التاسع',
      );
      expect(documentName(DocumentLanguage.bilingual, 'en', 'A', null), 'A');
      expect(documentName(null, 'ar', 'Grade 9', 'الصف التاسع'), 'الصف التاسع');
      expect(documentName(null, 'en', 'Grade 9', 'الصف التاسع'), 'Grade 9');
    });

    test('an unknown language degrades to the reader', () {
      expect(DocumentLanguage.fromWire('fr'), isNull);
      expect(DocumentLanguage.fromWire(null), isNull);
      expect(
        DocumentLanguage.fromWire('bilingual'),
        DocumentLanguage.bilingual,
      );
      expect(documentDirection(DocumentLanguage.ar), TextDirection.rtl);
      expect(documentDirection(null), isNull);
    });

    test('a student Arabic name joins the parts that are there', () {
      expect(
        studentArabicName({
          'first_name_ar': 'هدى',
          'middle_name_ar': null,
          'last_name_ar': 'سالم',
        }),
        'هدى سالم',
      );
      expect(studentArabicName({'first_name': 'Huda'}), isNull);
    });
  });

  group('documents parse the Arabic additions defensively', () {
    test('a certificate issued in Arabic', () {
      final content = CertificateContent.fromJson({
        'kind': 'term_report',
        'language': 'ar',
        'school': {'name': 'Al Noor', 'name_ar': 'النور'},
        'academic_year': {'name': '2026', 'name_ar': '٢٠٢٦'},
        'term': {'name': 'Term 1', 'name_ar': 'الفصل الأول'},
        'student': {
          'first_name': 'Huda',
          'last_name': 'Salem',
          'first_name_ar': 'هدى',
        },
        'grade_level_name': 'Grade 9',
        'grade_level_name_ar': 'الصف التاسع',
        'section_name': 'A',
        'subjects': [
          {
            'code': 'M',
            'name': 'Mathematics',
            'name_ar': 'الرياضيات',
            'max_marks': 100,
          },
        ],
        'overall': <String, Object?>{},
      });
      expect(content.language, DocumentLanguage.ar);
      expect(content.schoolNameAr, 'النور');
      expect(content.termNameAr, 'الفصل الأول');
      expect(content.studentNameAr, 'هدى');
      expect(content.gradeLevelNameAr, 'الصف التاسع');
      expect(content.sectionNameAr, isNull);
      expect(content.subjects.single.nameAr, 'الرياضيات');
    });

    test(
      'a transcript issued before 000264 has neither language nor Arabic names',
      () {
        final content = TranscriptContent.fromJson({
          'school': {'name': 'Al Noor'},
          'student': {'first_name': 'Huda', 'last_name': 'Salem'},
          'years': [
            {
              'academic_year': {'name': '2026'},
              'grade_level_name': 'Grade 9',
              'section_name': 'A',
              'subjects': [
                {'code': 'M', 'name': 'Mathematics', 'max_marks': 100},
              ],
              'overall': <String, Object?>{},
            },
          ],
          'cumulative': <String, Object?>{},
        });
        expect(content.language, isNull);
        expect(content.schoolNameAr, isNull);
        expect(content.studentNameAr, isNull);
        expect(content.years.single.gradeLevelNameAr, isNull);
        expect(content.years.single.subjects.single.nameAr, isNull);
      },
    );
  });
}
