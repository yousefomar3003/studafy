import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/offline/offline_database.dart';
import 'package:studafy_mobile/src/core/offline/offline_providers.dart';
import 'package:studafy_mobile/src/features/parent/application/parent_providers.dart';
import 'package:studafy_mobile/src/features/parent/domain/family_finance.dart';
import 'package:studafy_mobile/src/features/student/application/current_term_provider.dart';

import '../support.dart';

void main() {
  late OfflineDatabase database;

  setUp(() => database = OfflineDatabase(NativeDatabase.memory()));
  tearDown(() => database.close());

  ProviderContainer container(
    FakeStudafyApiClient api, {
    FamilyFinanceView? finance,
  }) {
    final c = ProviderContainer(
      overrides: [
        apiClientProvider.overrideWithValue(api),
        currentTermProvider.overrideWith((ref) => termFixture()),
        offlineDatabaseProvider.overrideWithValue(database),
        if (finance != null)
          familyFinanceClientProvider.overrideWithValue(FakeFamilyFinanceClient(finance)),
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

  group('childComparisonProvider', () {
    test('scopes the request to the current term and surfaces exactly the linked children',
        () async {
      final api = apiWith(['child-1', 'child-2']);

      final report = await container(api).read(childComparisonProvider.future);

      expect(api.childComparisonReports.lastTermId, 'term-1');
      expect(report.children.map((c) => c.studentId), ['child-1', 'child-2']);
    });
  });

  group('selectedChildProvider', () {
    test('defaults to the first linked child when nothing has been picked', () async {
      final c = container(apiWith(['child-1', 'child-2']));
      await c.read(childComparisonProvider.future);

      expect(c.read(selectedChildProvider).value?.studentId, 'child-1');
    });

    test('a pick persists and is restored by a fresh container on the same device', () async {
      final c1 = container(apiWith(['child-1', 'child-2']));
      await c1.read(childComparisonProvider.future);
      await c1.read(selectedChildControllerProvider.notifier).select('child-2');

      // A brand-new container (new provider state) sharing the same on-device store.
      final c2 = container(apiWith(['child-1', 'child-2']));
      await c2.read(childComparisonProvider.future);
      await c2.read(persistedSelectedChildIdProvider.future);

      expect(c2.read(selectedChildProvider).value?.studentId, 'child-2');
    });

    test('falls back to the first child when the remembered id is no longer linked', () async {
      final c1 = container(apiWith(['child-1', 'child-2']));
      await c1.read(childComparisonProvider.future);
      await c1.read(selectedChildControllerProvider.notifier).select('child-2');

      // child-2 has since been unlinked — only child-1 and child-3 come back now.
      final c2 = container(apiWith(['child-1', 'child-3']));
      await c2.read(childComparisonProvider.future);
      await c2.read(persistedSelectedChildIdProvider.future);

      expect(c2.read(selectedChildProvider).value?.studentId, 'child-1');
    });

    test('is null when the parent has no linked children', () async {
      final c = container(apiWith(const []));
      await c.read(childComparisonProvider.future);

      expect(c.read(selectedChildProvider).value, isNull);
    });
  });

  group('family finance', () {
    test('parentFamilyIdProvider is null and no finance call is made without a household',
        () async {
      final finance = FamilyFinanceView(
        sections: const [],
        householdTotals: const [],
        dataAsOf: null,
      );
      final financeClient = FakeFamilyFinanceClient(finance);
      final c = ProviderContainer(
        overrides: [
          apiClientProvider.overrideWithValue(apiWith(const [])),
          currentTermProvider.overrideWith((ref) => termFixture()),
          offlineDatabaseProvider.overrideWithValue(database),
          familyFinanceClientProvider.overrideWithValue(financeClient),
        ],
      );
      addTearDown(c.dispose);

      expect(await c.read(parentFamilyIdProvider.future), isNull);
      expect(await c.read(familyFinanceProvider.future), isNull);
      expect(financeClient.fetchedFamilyIds, isEmpty);
    });

    test('familyFinanceProvider fetches the household balances for the resolved family',
        () async {
      final api = FakeStudafyApiClient(
        families: FakeFamiliesClient(families: [familyFixture(id: 'fam-9')]),
      );
      final view = FamilyFinanceView(
        sections: [
          financeSection(studentId: 'child-1', totals: [moneyTotal(minor: 125000)]),
        ],
        householdTotals: [moneyTotal(minor: 125000)],
        dataAsOf: DateTime.parse('2026-03-01T00:00:00.000Z'),
      );
      final c = container(api, finance: view);

      final resolved = await c.read(familyFinanceProvider.future);

      expect(resolved!.amountsDueFor('child-1').single.outstandingMinor, 125000);
      expect(resolved.amountsDueFor('child-2'), isEmpty);
    });
  });

  group('parentNotificationsProvider', () {
    test('returns the feed newest first', () async {
      final api = FakeStudafyApiClient(
        notifications: FakeNotificationsClient(
          notifications: [
            notificationFixture(id: 'old', createdAt: DateTime.utc(2026, 1, 1)),
            notificationFixture(id: 'new', createdAt: DateTime.utc(2026, 2, 1)),
            notificationFixture(id: 'mid', createdAt: DateTime.utc(2026, 1, 15)),
          ],
        ),
      );

      final feed = await container(api).read(parentNotificationsProvider.future);

      expect(feed.map((n) => n.id), ['new', 'mid', 'old']);
    });
  });
}
