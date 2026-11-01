import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/account/application/account_settings_providers.dart';
import 'package:studafy_mobile/src/features/account/domain/own_staff_record.dart';
import 'package:studafy_mobile/src/features/account/presentation/own_staff_record_screen.dart';

import 'account_test_app.dart';

Map<String, Object?> _field(
  String id,
  String type,
  String label, {
  List<Map<String, Object?>> options = const [],
}) => {
  'id': id,
  'field_type': type,
  'label_en': label,
  'label_ar': label,
  'help_en': null,
  'help_ar': null,
  'required': false,
  'options': options,
  'sort_order': 0,
  'visibility': 'staff_only',
  'sensitivity': 'standard',
  'has_expiry': false,
};

Map<String, Object?> _entry(
  Map<String, Object?> field, {
  Object? value,
  bool missing = false,
  Map<String, Object?>? document,
}) => {
  'field': field,
  'archived': false,
  'value': value,
  'masked': false,
  'mask': null,
  'answered': value != null || document != null,
  'missing': missing,
  'answered_in_version': null,
  'answered_field': null,
  'document': document,
  'updated_at': null,
};

/// The API's response for a teacher's own record, exactly as JSON: the hand-written model must
/// parse a null `value` and a null `document`, which the generated one could not.
OwnStaffRecord _record() => OwnStaffRecord.fromJson({
  'subject_kind': 'staff',
  'subject_id': 'user-1',
  'template_version': 2,
  'missing_required': 1,
  'entries': [
    _entry(
      _field('f-qual', 'short_text', 'Qualification'),
      value: 'BEd Mathematics',
    ),
    _entry(
      _field(
        'f-contract',
        'single_choice',
        'Contract type',
        options: [
          {'value': 'permanent', 'label_en': 'Permanent', 'label_ar': 'دائم'},
        ],
      ),
      value: 'permanent',
    ),
    _entry(
      _field('f-start', 'date', 'Start date'),
      value: '2026-09-01T00:00:00.000Z',
    ),
    _entry(_field('f-first-aid', 'yes_no', 'First aid trained'), value: true),
    _entry(_field('f-bus', 'short_text', 'Bus duty'), missing: true),
    _entry(
      _field('f-licence', 'document', 'Teaching licence'),
      document: {
        'status': 'verified',
        'file_name': 'licence.pdf',
        'content_type': 'application/pdf',
        'size_bytes': 1024,
        'sensitive': false,
        'uploaded_at': '2026-10-01T00:00:00.000Z',
        'verified_at': '2026-10-02T00:00:00.000Z',
        'expires_on': '2029-06-30',
        'expiry_state': 'valid',
      },
    ),
  ],
});

Widget _screen(Future<OwnStaffRecord> Function() load, {List<String>? opened}) {
  return ProviderScope(
    overrides: [
      ownStaffRecordProvider.overrideWith((ref) => load()),
      ownStaffRecordDocumentUrlProvider.overrideWithValue((fieldId) async {
        opened?.add(fieldId);
        throw StateError('no browser in tests');
      }),
    ],
    child: accountScreenApp(const OwnStaffRecordScreen()),
  );
}

void main() {
  testWidgets('lists each field with its answer, read-only', (tester) async {
    await pumpAccountScreen(tester, _screen(() async => _record()));

    expect(find.text('My staff record'), findsOneWidget);
    expect(find.text('BEd Mathematics'), findsOneWidget);
    // A choice reads as the school's label for it, a date as its calendar day.
    expect(find.text('Permanent'), findsOneWidget);
    expect(find.text('2026-09-01'), findsOneWidget);
    expect(find.text('Yes'), findsOneWidget);
    expect(find.text('Not filled in'), findsOneWidget);
    expect(find.textContaining('licence.pdf'), findsOneWidget);
    expect(find.textContaining('Verified'), findsOneWidget);
    expect(find.byKey(const Key('ownStaffRecordMissing')), findsOneWidget);
    // Nothing here edits or reveals anything.
    expect(find.byType(TextField), findsNothing);
    expect(find.textContaining('Reveal'), findsNothing);
  });

  testWidgets(
    'opens a document through a fresh URL, and says so when it fails',
    (tester) async {
      final opened = <String>[];
      await pumpAccountScreen(
        tester,
        _screen(() async => _record(), opened: opened),
      );

      await tester.tap(find.widgetWithText(TextButton, 'Open'));
      await tester.pumpAndSettle();
      expect(opened, ['f-licence']);
      expect(
        find.text(
          'Couldn\'t open the file. Check your connection and try again.',
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets('says when the school has not set up staff records', (
    tester,
  ) async {
    await pumpAccountScreen(
      tester,
      _screen(
        () async => OwnStaffRecord.fromJson({
          'template_version': 0,
          'missing_required': 0,
          'entries': <Object?>[],
        }),
      ),
    );
    expect(
      find.text('Your school hasn\'t set up staff records yet.'),
      findsOneWidget,
    );
  });

  testWidgets('offers a retry when the record cannot be loaded', (
    tester,
  ) async {
    await pumpAccountScreen(tester, _screen(() async => throw StateError('x')));
    expect(find.text('Couldn\'t load your staff record.'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'Try again'), findsOneWidget);
  });

  testWidgets('meets the tap-target, label and contrast guidelines', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await pumpAccountScreen(tester, _screen(() async => _record()));
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(textContrastGuideline));
    handle.dispose();
  });

  test('only staff roles get the Profile entry', () {
    expect(holdsStaffRole(const ['INSTRUCTOR']), isTrue);
    expect(holdsStaffRole(const ['ATTENDANCE_OFFICER']), isTrue);
    expect(holdsStaffRole(const ['ORG_ADMIN', 'PARENT']), isTrue);
    expect(holdsStaffRole(const ['PARENT']), isFalse);
    expect(holdsStaffRole(const ['STUDENT']), isFalse);
    expect(holdsStaffRole(const ['SUPPORT_AGENT']), isFalse);
  });
}
