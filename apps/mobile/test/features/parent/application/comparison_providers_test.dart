import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/term.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/features/parent/application/comparison_providers.dart';
import 'package:studafy_mobile/src/features/student/application/grade_providers.dart';

import '../support.dart';

Term _term(String id, {required int sequence, required String status}) {
  return Term.fromJson({
    'id': id,
    'school_id': 'school-1',
    'academic_year_id': 'year-1',
    'code': 'T$sequence',
    'name': 'Term $sequence',
    'sequence_number': sequence,
    'starts_on': '2026-01-01',
    'ends_on': '2026-04-01',
    'status': status,
    'created_at': '2026-01-01T00:00:00.000Z',
    'updated_at': '2026-01-01T00:00:00.000Z',
  });
}

void main() {
  ProviderContainer container(FakeStudafyApiClient api, {required List<Term> terms}) {
    final c = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        academicYearTermsProvider.overrideWith((ref) async => terms),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  FakeStudafyApiClient apiWith(List<String> childIds) {
    return FakeStudafyApiClient(
      childComparisonReports: FakeChildComparisonReportsClient(
        comparisonReport([
          for (final id in childIds) childItem(id: id, name: 'Child $id'),
        ]),
      ),
    );
  }

  group('comparisonReportProvider', () {
    test('defaults to the academic year\'s active term', () async {
      final api = apiWith(['child-1', 'child-2']);
      final terms = [
        _term('term-1', sequence: 1, status: 'closed'),
        _term('term-2', sequence: 2, status: 'active'),
      ];

      final report = await container(api, terms: terms).read(comparisonReportProvider.future);

      expect(api.childComparisonReports.lastTermId, 'term-2');
      expect(report.children.map((child) => child.studentId), ['child-1', 'child-2']);
    });

    test('an explicit pick overrides the default term', () async {
      final api = apiWith(['child-1']);
      final terms = [
        _term('term-1', sequence: 1, status: 'closed'),
        _term('term-2', sequence: 2, status: 'active'),
      ];
      final c = container(api, terms: terms);

      c.read(selectedComparisonTermProvider.notifier).select('term-1');
      await c.read(comparisonReportProvider.future);

      expect(api.childComparisonReports.lastTermId, 'term-1');
    });

    test('falls back to the default term once the picked one no longer exists', () async {
      final api = apiWith(['child-1']);
      final terms = [
        _term('term-1', sequence: 1, status: 'closed'),
        _term('term-2', sequence: 2, status: 'active'),
      ];
      final c = container(api, terms: terms);

      c.read(selectedComparisonTermProvider.notifier).select('stale-term');
      await c.read(comparisonReportProvider.future);

      expect(api.childComparisonReports.lastTermId, 'term-2');
    });

    test('errors when the school has no academic terms', () async {
      final c = container(apiWith(const []), terms: const []);

      await expectLater(c.read(comparisonReportProvider.future), throwsStateError);
    });
  });
}
