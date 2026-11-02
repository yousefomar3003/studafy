import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/custom_lists/application/custom_lists_providers.dart';
import 'package:studafy_mobile/src/features/custom_lists/data/custom_lists_client.dart';
import 'package:studafy_mobile/src/features/custom_lists/domain/custom_list.dart';
import 'package:studafy_mobile/src/features/custom_lists/presentation/custom_list_screen.dart';
import 'package:studafy_mobile/src/features/custom_lists/presentation/custom_lists_screen.dart';
import 'package:studafy_mobile/src/features/custom_lists/presentation/linked_custom_lists_section.dart';
import 'package:studafy_mobile/src/features/custom_lists/presentation/student_custom_lists_screen.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';

import '../account/account_test_app.dart';

/// Custom lists on the phone, read-only: the lists a member of staff may read, one list's rows
/// (sensitive cells as their mask, never revealed; dates as their calendar day; search, sort and
/// paging sent to the API), and the Lists section on a student's or class's page, which takes no
/// space unless something links there. JSON follows the API's `custom-lists/schemas.ts`.

const _padlock = 'c-padlock';
const _size = 'c-size';
const _issued = 'c-issued';

Map<String, Object?> _column(
  String id,
  String type,
  String label, {
  bool sensitive = false,
  bool archived = false,
  List<Map<String, Object?>> options = const [],
}) => {
  'id': id,
  'field_type': type,
  'label_en': label,
  'label_ar': label,
  'required': false,
  'sensitivity': sensitive ? 'sensitive' : 'standard',
  'sort_order': 0,
  'archived': archived,
  'options': options,
};

final _columns = [
  _column(
    _size,
    'single_choice',
    'Size',
    options: [
      {'value': 'small', 'label_en': 'Small', 'label_ar': 'صغير'},
    ],
  ),
  _column(
    'c-extras',
    'multi_choice',
    'Extras',
    options: [
      {'value': 'hook', 'label_en': 'Hook', 'label_ar': 'علاقة'},
      {'value': 'shelf', 'label_en': 'Shelf', 'label_ar': 'رف'},
    ],
  ),
  _column('c-checked', 'yes_no', 'Checked'),
  _column(_issued, 'date', 'Issued on'),
  _column('c-number', 'number', 'Locker number'),
  _column(_padlock, 'short_text', 'Padlock code', sensitive: true),
  _column('c-old', 'short_text', 'Old notes', archived: true),
];

Map<String, Object?> _summary(String id, String name, {int rows = 2}) => {
  'id': id,
  'name_en': name,
  'name_ar': name,
  'description': null,
  'audience': 'staff',
  'links': {'student': true, 'parent': false, 'staff': false, 'class': false},
  'archived': false,
  'row_count': rows,
  'column_count': 6,
  'can_manage': false,
  'created_at': '2026-10-01T00:00:00.000Z',
  'updated_at': '2026-10-01T00:00:00.000Z',
};

Map<String, Object?> _cell(String column, Object? value, {String? mask}) => {
  'column_id': column,
  'value': mask == null ? value : null,
  'masked': mask != null,
  'mask': mask,
};

Map<String, Object?> _row(String id, {String? linkName, bool link = true}) => {
  'id': id,
  'link': link
      ? {'kind': 'student', 'id': 'student-1', 'name': linkName}
      : null,
  'cells': [
    _cell(_size, 'small'),
    _cell('c-extras', ['hook', 'shelf']),
    _cell('c-checked', true),
    // A date may come back as a midnight-UTC timestamp: the card shows the calendar day.
    _cell(_issued, '2026-09-01T00:00:00.000Z'),
    _cell('c-number', 42),
    _cell(_padlock, null, mask: '•••• 7890'),
    _cell('c-old', 'hidden because archived'),
  ],
  'created_at': '2026-10-01T00:00:00.000Z',
  'updated_at': '2026-10-01T00:00:00.000Z',
};

class _RowsCall {
  _RowsCall(this.q, this.sort, this.descending, this.offset);
  final String? q;
  final String? sort;
  final bool descending;
  final int offset;
}

/// Answers from fixtures and records what the screens asked for.
class _FakeClient implements CustomListsClient {
  _FakeClient({
    this.summaries = const [],
    this.total = 2,
    this.linkedLists = const [],
    this.failLists = false,
  });

  final List<Map<String, Object?>> summaries;
  final int total;
  final List<Map<String, Object?>> linkedLists;
  final bool failLists;
  final List<_RowsCall> rowCalls = [];
  final List<(String, String)> linkedCalls = [];

  @override
  Future<List<CustomListSummary>> lists() async {
    if (failLists) throw StateError('offline');
    return [for (final list in summaries) CustomListSummary.fromJson(list)];
  }

  @override
  Future<CustomListDetail> detail(String listId) async =>
      CustomListDetail.fromJson({
        ..._summary(listId, 'Lockers'),
        'description': 'One row per locker.',
        'columns': _columns,
      });

  @override
  Future<CustomListRowPage> rows(
    String listId, {
    String? q,
    String? sort,
    bool descending = false,
    int limit = 50,
    int offset = 0,
  }) async {
    rowCalls.add(_RowsCall(q, sort, descending, offset));
    final remaining = total - offset;
    final count = remaining < limit ? remaining : limit;
    return CustomListRowPage.fromJson({
      'rows': [
        for (var index = 0; index < count; index++)
          _row(
            'row-${offset + index}',
            linkName: index.isEven ? 'Lina Saleh' : null,
          ),
      ],
      'total': total,
      'limit': limit,
      'offset': offset,
    });
  }

  @override
  Future<List<LinkedCustomList>> linked(
    String subjectKind,
    String subjectId,
  ) async {
    linkedCalls.add((subjectKind, subjectId));
    return [for (final list in linkedLists) LinkedCustomList.fromJson(list)];
  }
}

Widget _app(
  Widget screen,
  _FakeClient client, {
  List<String> roles = const ['INSTRUCTOR'],
}) {
  return ProviderScope(
    overrides: [
      customListsClientProvider.overrideWithValue(client),
      sessionRolesProvider.overrideWithValue(roles),
    ],
    child: accountScreenApp(screen),
  );
}

Map<String, Object?> _linked(String id, String name, {int total = 1}) => {
  'list': {'id': id, 'name_en': name, 'name_ar': name},
  'columns': _columns.where((column) => column['archived'] != true).toList(),
  'rows': [_row('row-linked-$id')],
  'total': total,
};

void main() {
  group('the lists screen', () {
    testWidgets('shows each list with its audience and row count', (
      tester,
    ) async {
      final client = _FakeClient(
        summaries: [
          _summary('l-1', 'Lockers', rows: 1),
          _summary('l-2', 'Bus routes', rows: 12),
        ],
      );
      await pumpAccountScreen(tester, _app(const CustomListsScreen(), client));

      expect(find.text('Lists'), findsOneWidget);
      expect(find.text('Lockers'), findsOneWidget);
      expect(find.text('All staff · 1 row'), findsOneWidget);
      expect(find.text('All staff · 12 rows'), findsOneWidget);

      await tester.tap(find.text('Bus routes'));
      await tester.pumpAndSettle();
      expect(find.byType(CustomListScreen), findsOneWidget);
    });

    testWidgets('says when there are no lists, and offers a retry on error', (
      tester,
    ) async {
      await pumpAccountScreen(
        tester,
        _app(const CustomListsScreen(), _FakeClient()),
      );
      expect(find.byKey(const Key('customListsEmpty')), findsOneWidget);

      await pumpAccountScreen(
        tester,
        _app(const CustomListsScreen(), _FakeClient(failLists: true)),
      );
      expect(find.text('Couldn\'t load your school\'s lists.'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Try again'), findsOneWidget);
    });
  });

  group('one list', () {
    testWidgets(
      'shows rows read-only: a sensitive cell as its mask, a date as its day',
      (tester) async {
        final client = _FakeClient();
        await pumpAccountScreen(
          tester,
          _app(const CustomListScreen(listId: 'l-1', title: 'Lockers'), client),
        );

        expect(find.text('One row per locker.'), findsOneWidget);
        expect(
          find.text('To add or change rows, use Studafy on the web.'),
          findsOneWidget,
        );
        expect(find.text('2 rows'), findsOneWidget);
        expect(find.textContaining('Lina Saleh · Student'), findsOneWidget);
        // A linked student the user cannot see is never resolved behind their back.
        expect(
          find.textContaining('Someone you can\'t see · Student'),
          findsOneWidget,
        );
        expect(find.textContaining('Small'), findsNWidgets(2));
        expect(find.textContaining('Hook, Shelf'), findsNWidgets(2));
        expect(find.textContaining('2026-09-01'), findsNWidgets(2));
        expect(find.textContaining('T00:00'), findsNothing);
        expect(find.textContaining('Locker number: 42'), findsNWidgets(2));
        expect(find.textContaining('•••• 7890'), findsNWidgets(2));
        expect(find.byIcon(Icons.lock_outline), findsNWidgets(2));
        // An archived column is hidden; nothing reveals or edits anything.
        expect(find.textContaining('Old notes'), findsNothing);
        expect(find.textContaining('Reveal'), findsNothing);
        expect(find.byType(TextField), findsOneWidget); // the search box only
        expect(client.rowCalls.single.offset, 0);
      },
    );

    testWidgets('search is sent after typing pauses', (tester) async {
      final client = _FakeClient();
      await pumpAccountScreen(
        tester,
        _app(const CustomListScreen(listId: 'l-1', title: 'Lockers'), client),
      );
      await tester.enterText(find.byKey(const Key('customListSearch')), 'hin');
      await tester.pump(const Duration(milliseconds: 100));
      await tester.enterText(
        find.byKey(const Key('customListSearch')),
        'hinge',
      );
      await tester.pump(customListSearchDebounce);
      await tester.pumpAndSettle();

      expect(client.rowCalls.map((call) => call.q).toList(), ['', 'hinge']);
      expect(client.rowCalls.last.offset, 0);
    });

    testWidgets('sorts by a column that is not sensitive, either way', (
      tester,
    ) async {
      final client = _FakeClient();
      await pumpAccountScreen(
        tester,
        _app(const CustomListScreen(listId: 'l-1', title: 'Lockers'), client),
      );
      await tester.tap(find.byKey(const Key('customListSort')));
      await tester.pumpAndSettle();
      // A sensitive column can be neither sorted nor searched, so it is not offered.
      expect(find.text('Padlock code'), findsNothing);
      await tester.tap(find.text('Issued on').last);
      await tester.pumpAndSettle();
      expect(client.rowCalls.last.sort, _issued);
      expect(client.rowCalls.last.descending, isFalse);

      await tester.tap(find.byKey(const Key('customListSort')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Descending'));
      await tester.pumpAndSettle();
      expect(client.rowCalls.last.sort, _issued);
      expect(client.rowCalls.last.descending, isTrue);
    });

    testWidgets('loads the next page near the end of the list', (tester) async {
      final client = _FakeClient(total: customListPageSize + 5);
      await pumpAccountScreen(
        tester,
        _app(const CustomListScreen(listId: 'l-1', title: 'Lockers'), client),
      );
      expect(client.rowCalls.map((call) => call.offset), [0]);
      expect(find.text('${customListPageSize + 5} rows'), findsOneWidget);
      await tester.fling(find.byType(ListView), const Offset(0, -20000), 5000);
      await tester.pumpAndSettle();
      expect(client.rowCalls.map((call) => call.offset), [
        0,
        customListPageSize,
      ]);
      expect(find.text('Lina Saleh · Student'), findsWidgets);
    });

    testWidgets('says when a search matches nothing', (tester) async {
      await pumpAccountScreen(
        tester,
        _app(
          const CustomListScreen(listId: 'l-1', title: 'Lockers'),
          _FakeClient(total: 0),
        ),
      );
      expect(find.text('This list has no rows yet.'), findsOneWidget);
    });

    testWidgets('meets the tap-target, label and contrast guidelines', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await pumpAccountScreen(
        tester,
        _app(
          const CustomListScreen(listId: 'l-1', title: 'Lockers'),
          _FakeClient(),
        ),
      );
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(iOSTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      await expectLater(tester, meetsGuideline(textContrastGuideline));
      handle.dispose();
    });
  });

  group('the Lists section on a student or class page', () {
    const section = Scaffold(
      body: LinkedCustomListsSection(
        subjectKind: 'class',
        subjectId: 'class-1',
      ),
    );

    testWidgets('shows linked rows by list, without repeating the link', (
      tester,
    ) async {
      final client = _FakeClient(
        linkedLists: [_linked('l-1', 'Bus groups', total: 3)],
      );
      await pumpAccountScreen(tester, _app(section, client));

      expect(client.linkedCalls, [('class', 'class-1')]);
      expect(find.byKey(const Key('linkedCustomLists')), findsOneWidget);
      expect(find.text('Bus groups'), findsOneWidget);
      expect(find.textContaining('•••• 7890'), findsOneWidget);
      expect(find.textContaining('· Student'), findsNothing);
      expect(find.text('And 2 more rows in this list'), findsOneWidget);
    });

    testWidgets('takes no space when nothing links here', (tester) async {
      final client = _FakeClient();
      await pumpAccountScreen(tester, _app(section, client));
      expect(client.linkedCalls, [('class', 'class-1')]);
      expect(find.byKey(const Key('linkedCustomLists')), findsNothing);
      expect(find.text('Lists'), findsNothing);
    });

    testWidgets('is never fetched for a family member', (tester) async {
      final client = _FakeClient(linkedLists: [_linked('l-1', 'Bus groups')]);
      await pumpAccountScreen(
        tester,
        _app(section, client, roles: const ['PARENT']),
      );
      expect(client.linkedCalls, isEmpty);
      expect(find.byKey(const Key('linkedCustomLists')), findsNothing);
    });

    testWidgets('a student with no linked rows says so on their screen', (
      tester,
    ) async {
      await pumpAccountScreen(
        tester,
        _app(
          const StudentCustomListsScreen(
            studentId: 'student-1',
            studentName: 'Omar Haddad',
          ),
          _FakeClient(),
        ),
      );
      expect(find.text('Omar Haddad'), findsOneWidget);
      expect(find.text('No lists mention this student.'), findsOneWidget);
    });
  });

  test('every school staff role uses lists; families never', () {
    for (final role in const [
      'ORG_ADMIN',
      'PRINCIPAL',
      'ATTENDANCE_OFFICER',
      'FINANCE',
      'INSTRUCTOR',
      'SUPER_ADMIN',
    ]) {
      expect(canUseCustomLists([role]), isTrue, reason: role);
    }
    for (final role in const ['PARENT', 'STUDENT', 'GUEST', 'SUPPORT_AGENT']) {
      expect(canUseCustomLists([role]), isFalse, reason: role);
    }
  });
}
