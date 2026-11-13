import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_consent_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_consent_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_consent.dart';
import 'package:studafy_mobile/src/features/ai/presentation/ai_data_sharing_screen.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_consent_gate.dart';

import '../../../support/wrap_with_localization.dart';

const _disclosure = AiDataSharingDisclosure(
  version: '2026-09-28',
  providerName: 'Anthropic',
  privacyPolicyUrl: null,
  dataCategories: AiDataCategory.values,
);

/// Stands in for the API's consent store: records every grant/withdraw call and answers with the
/// resulting status, or throws [grantError] from grant.
class _FakeConsentClient implements AiConsentClient {
  _FakeConsentClient({this.grantedAt, this.grantError});

  DateTime? grantedAt;
  final Object? grantError;
  final grants = <String>[];
  var withdrawals = 0;

  AiConsentStatus get _status => AiConsentStatus(disclosure: _disclosure, grantedAt: grantedAt);

  @override
  Future<AiConsentStatus> status() async => _status;

  @override
  Future<AiConsentStatus> grant(String version) async {
    grants.add(version);
    if (grantError != null) throw grantError!;
    grantedAt = DateTime.utc(2026, 9, 28);
    return _status;
  }

  @override
  Future<AiConsentStatus> withdraw() async {
    withdrawals++;
    grantedAt = null;
    return _status;
  }
}

const _featureText = 'AI feature screen';

Future<void> _pump(WidgetTester tester, _FakeConsentClient client, Widget home) async {
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [aiConsentClientProvider.overrideWithValue(client)],
        child: Builder(
          builder: (context) => MaterialApp(
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: home,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _pumpGate(WidgetTester tester, _FakeConsentClient client) =>
    _pump(tester, client, const AiConsentGate(child: Scaffold(body: Text(_featureText))));

void main() {
  group('AiConsentGate', () {
    testWidgets('without consent, opens the modal naming the provider and every data category '
        'and never builds the feature', (tester) async {
      await _pumpGate(tester, _FakeConsentClient());

      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text('Share your data with Anthropic?'), findsOneWidget);
      expect(find.textContaining('Your questions and prompts'), findsOneWidget);
      expect(find.textContaining('Study material content'), findsOneWidget);
      expect(find.textContaining('A random account ID'), findsOneWidget);
      expect(find.text(_featureText), findsNothing);
    });

    testWidgets('allowing records consent to the shown version and unlocks the feature', (
      tester,
    ) async {
      final client = _FakeConsentClient();
      await _pumpGate(tester, client);

      await tester.tap(find.text('Allow'));
      await tester.pumpAndSettle();

      expect(client.grants, ['2026-09-28']);
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text(_featureText), findsOneWidget);
    });

    testWidgets('declining leaves the feature locked, with a way back to the modal', (
      tester,
    ) async {
      final client = _FakeConsentClient();
      await _pumpGate(tester, client);

      await tester.tap(find.text("Don't allow"));
      await tester.pumpAndSettle();

      expect(client.grants, isEmpty);
      expect(find.text(_featureText), findsNothing);
      expect(find.text('AI features are off'), findsOneWidget);

      await tester.tap(find.text('Review and allow'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
    });

    testWidgets('with consent, builds the feature without asking', (tester) async {
      await _pumpGate(tester, _FakeConsentClient(grantedAt: DateTime.utc(2026, 9, 1)));

      expect(find.byType(AlertDialog), findsNothing);
      expect(find.text(_featureText), findsOneWidget);
    });

    testWidgets('an outdated disclosure closes the modal without unlocking', (tester) async {
      final outdated = DioException(
        requestOptions: RequestOptions(path: '/api/ai/consent'),
        error: const ApiException(
          status: 409,
          title: 'Conflict',
          code: 'AI_CONSENT_DISCLOSURE_OUTDATED',
        ),
      );
      await _pumpGate(tester, _FakeConsentClient(grantError: outdated));

      await tester.tap(find.text('Allow'));
      await tester.pumpAndSettle();

      expect(find.text(_featureText), findsNothing);
      expect(find.text('AI features are off'), findsOneWidget);
    });

    testWidgets('a failed save keeps the modal open with an error', (tester) async {
      await _pumpGate(tester, _FakeConsentClient(grantError: Exception('offline')));

      await tester.tap(find.text('Allow'));
      await tester.pumpAndSettle();

      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text("Couldn't save your choice. Please try again."), findsOneWidget);
      expect(find.text(_featureText), findsNothing);
    });
  });

  group('AiDataSharingScreen', () {
    testWidgets('withdrawing, once confirmed, records the withdrawal', (tester) async {
      final client = _FakeConsentClient(grantedAt: DateTime.utc(2026, 9, 1));
      await _pump(tester, client, const AiDataSharingScreen());

      expect(find.textContaining('You allowed data sharing on'), findsOneWidget);

      await tester.tap(find.text('Withdraw consent'));
      await tester.pumpAndSettle();
      expect(find.text('Withdraw consent?'), findsOneWidget);

      await tester.tap(find.text('Withdraw'));
      await tester.pumpAndSettle();

      expect(client.withdrawals, 1);
      expect(find.text('Data sharing is not allowed, so AI features are off.'), findsOneWidget);
      expect(find.text('Allow data sharing'), findsOneWidget);
    });

    testWidgets('cancelling the confirmation keeps consent', (tester) async {
      final client = _FakeConsentClient(grantedAt: DateTime.utc(2026, 9, 1));
      await _pump(tester, client, const AiDataSharingScreen());

      await tester.tap(find.text('Withdraw consent'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(client.withdrawals, 0);
      expect(find.text('Withdraw consent'), findsOneWidget);
    });
  });
}
