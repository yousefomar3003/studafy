import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/api/generated/models/account_profile.dart';
import 'package:studafy_mobile/src/core/api/generated/models/legal_acceptance_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/school3.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/parent/application/student_ai_providers.dart';
import 'package:studafy_mobile/src/features/parent/data/student_ai_client.dart';
import 'package:studafy_mobile/src/features/parent/domain/student_ai_offer.dart';
import 'package:studafy_mobile/src/features/parent/presentation/student_ai_opt_in_screen.dart';
import 'package:studafy_mobile/src/features/parent/presentation/widgets/student_ai_home_card.dart';
import 'package:studafy_mobile/src/features/shell/application/shell_providers.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../student_ai_fixtures.dart';

/// Student AI on the parent's phone: the school's offer with what it includes and the commitment,
/// never a price (the school tells parents the price); a confirmation box that must be ticked
/// before Join works; the exact opt-in body (no price echoed); new terms refreshing the offer; the
/// closed window; one card per child; and an opt-in with no way to cancel it.
class _FakeStudentAiClient extends Fake implements StudentAiClient {
  _FakeStudentAiClient(this.offers);

  StudentAiOffers offers;
  final List<Map<String, Object?>> optIns = [];
  int fetches = 0;

  /// Thrown (once) by the next [optIn] instead of succeeding; [onError] runs first, standing in
  /// for whatever changed on the server.
  ApiException? nextError;
  void Function()? onError;
  StudentAiOffers? afterOptIn;

  @override
  Future<StudentAiOffers> fetchOffers() async {
    fetches += 1;
    return offers;
  }

  @override
  Future<StudentAiOptIn> optIn({required String studentId, required String termsVersion}) async {
    optIns.add({'studentId': studentId, 'termsVersion': termsVersion});
    final error = nextError;
    if (error != null) {
      nextError = null;
      onError?.call();
      throw DioException(
        requestOptions: RequestOptions(path: '/api/parent/student-ai/opt-ins'),
        response: Response(
          requestOptions: RequestOptions(path: '/api/parent/student-ai/opt-ins'),
          statusCode: error.status,
        ),
        error: error,
      );
    }
    if (afterOptIn != null) offers = afterOptIn!;
    return StudentAiOptIn.fromJson(optInJson(studentId: studentId));
  }
}

AccountProfile _profile() => AccountProfile(
  userId: 'parent-1',
  displayName: 'Test Parent',
  email: 'parent@example.com',
  memberIds: const [],
  deletionScheduledFor: null,
  deletionRequiresMemberCredentials: false,
  activeStoreSubscriptions: const [],
  school: const School3(id: 'school-1', name: 'Alpha Academy'),
  legalAcceptance: LegalAcceptanceStatus(
    requiredValue: false,
    termsVersion: '2026-11-11',
    privacyVersion: '2026-11-11',
    acceptedAt: DateTime.utc(2026, 11, 11),
  ),
);

Future<void> _pump(
  WidgetTester tester,
  _FakeStudentAiClient client, {
  Widget? home,
  Locale locale = const Locale('en'),
}) async {
  tester.view
    ..physicalSize = const Size(400, 2400)
    ..devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [
          studentAiClientProvider.overrideWithValue(client),
          studentAiOffersProvider.overrideWith(
            (ref) => ref.watch(studentAiClientProvider).fetchOffers(),
          ),
          accountProfileProvider.overrideWith((ref) async => _profile()),
        ],
        child: Builder(
          builder: (context) => MaterialApp(
            theme: AppTheme.light,
            locale: context.locale,
            supportedLocales: context.supportedLocales,
            localizationsDelegates: context.localizationDelegates,
            home: home ?? const StudentAiOptInScreen(),
          ),
        ),
      ),
      startLocale: locale,
    ),
  );
  await tester.pumpAndSettle();
}

FilledButton _confirmButton(WidgetTester tester) =>
    tester.widget<FilledButton>(find.byKey(const Key('studentAiConfirm')));

void main() {
  setUpAll(ensureDateFormattingInitialized);

  /// No money on screen: no currency sign, no decimal amount, no "×" multiplication.
  void expectNoPrice() {
    expect(find.textContaining(RegExp(r'[$€£]|\d+[.,]\d{2}|×|USD|JOD')), findsNothing);
    expect(
      find.textContaining(RegExp(r'\b(pay|paid|buy|purchase|price:)\b', caseSensitive: false)),
      findsNothing,
    );
  }

  testWidgets('an open offer: offered by the school, what it includes, the terms, no price', (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeStudentAiClient(offersOf([availableOfferJson(id: 'child-1', name: 'Amir')])),
    );

    expect(find.text('Student AI for Amir'), findsOneWidget);
    expect(find.text('Offered by your school'), findsOneWidget);
    expect(find.text('From September 2026 to April 2027'), findsOneWidget);
    expect(find.text('What it includes'), findsOneWidget);
    expect(find.text('A study helper for Amir in the Studafy app.'), findsOneWidget);
    expect(
      find.text("It's committed for the school year and can't be cancelled mid-year."),
      findsOneWidget,
    );
    expect(find.text("It's part of your school fees."), findsOneWidget);
    expect(find.text('Your school will tell you the price.'), findsOneWidget);
    expect(find.text('Join'), findsOneWidget);
    expect(find.text('Available'), findsOneWidget);
    expectNoPrice();
  });

  testWidgets('a late opt-in shows the months left, as the API sends them', (tester) async {
    await _pump(
      tester,
      _FakeStudentAiClient(
        offersOf([availableOfferJson(id: 'child-1', name: 'Amir', startMonth: '2027-02-01')]),
      ),
    );

    expect(find.text('From February 2027 to April 2027'), findsOneWidget);
    expectNoPrice();
  });

  testWidgets('Join stays disabled until the box is ticked, then posts only the terms', (
    tester,
  ) async {
    final client = _FakeStudentAiClient(
      offersOf([availableOfferJson(id: 'child-1', name: 'Amir')]),
    );
    client.afterOptIn = offersOf([optedInOfferJson(id: 'child-1', name: 'Amir')]);
    await _pump(tester, client);

    expect(_confirmButton(tester).onPressed, isNull);
    await tester.tap(find.byKey(const Key('studentAiConfirm')));
    await tester.pump();
    expect(client.optIns, isEmpty);

    await tester.tap(find.byKey(const Key('studentAiAccept')));
    await tester.pump();
    expect(_confirmButton(tester).onPressed, isNotNull);

    await tester.tap(find.byKey(const Key('studentAiConfirm')));
    await tester.pumpAndSettle();

    expect(client.optIns, [
      {'studentId': 'child-1', 'termsVersion': 'ai-optin-2026-11'},
    ]);
    expect(find.text('Amir has joined Student AI.'), findsWidgets);
    // The offer reloads as confirmed: no box, no button.
    expect(find.byKey(const Key('studentAiConfirm')), findsNothing);
    expectNoPrice();
  });

  testWidgets('new terms refresh the offer, say so, and ask for a fresh tick', (tester) async {
    final client = _FakeStudentAiClient(
      offersOf([availableOfferJson(id: 'child-1', name: 'Amir')]),
    );
    client
      ..nextError = const ApiException(
        status: 409,
        title: 'Conflict',
        code: 'AI_OPTIN_TERMS_CHANGED',
      )
      ..onError = () {
        client.offers = offersOf([
          availableOfferJson(id: 'child-1', name: 'Amir'),
        ], termsVersion: 'ai-optin-2026-12');
      };
    await _pump(tester, client);

    await tester.tap(find.byKey(const Key('studentAiAccept')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('studentAiConfirm')));
    await tester.pumpAndSettle();

    expect(find.text('The terms have changed. Read them and confirm again.'), findsOneWidget);
    expect(_confirmButton(tester).onPressed, isNull);
    expect(client.fetches, 2);
  });

  testWidgets("a closed window says so with the school's name, and offers nothing to tick", (
    tester,
  ) async {
    await _pump(
      tester,
      _FakeStudentAiClient(offersOf([closedOfferJson(id: 'child-1', name: 'Amir')])),
    );

    expect(find.text('Joining Student AI is closed at Alpha Academy for now.'), findsOneWidget);
    expect(find.text('Closed'), findsOneWidget);
    expect(find.byKey(const Key('studentAiAccept')), findsNothing);
    expect(find.byKey(const Key('studentAiConfirm')), findsNothing);
  });

  testWidgets('several children: one card each, in their own state', (tester) async {
    await _pump(
      tester,
      _FakeStudentAiClient(
        offersOf([
          availableOfferJson(id: 'child-1', name: 'Amir'),
          optedInOfferJson(id: 'child-2', name: 'Lina'),
          closedOfferJson(id: 'child-3', name: 'Omar'),
        ]),
      ),
    );

    expect(find.text('Student AI for Amir'), findsOneWidget);
    expect(find.text('Student AI for Lina'), findsOneWidget);
    expect(find.text('Student AI for Omar'), findsOneWidget);
    expect(find.byKey(const Key('studentAiConfirm')), findsOneWidget);
    expect(find.text('Available'), findsOneWidget);
    expect(find.text('Confirmed'), findsOneWidget);
    expect(find.text('Closed'), findsOneWidget);
  });

  testWidgets('an opt-in shows what was confirmed and has no way to cancel it', (tester) async {
    await _pump(
      tester,
      _FakeStudentAiClient(
        offersOf([
          optedInOfferJson(
            id: 'child-1',
            name: 'Amir',
            source: 'school_on_behalf',
            waitingForSchool: true,
          ),
        ]),
      ),
    );

    expect(find.text('Amir has joined Student AI.'), findsOneWidget);
    expect(
      find.text('From September 2026 to April 2027 · Included in your school fees'),
      findsOneWidget,
    );
    expect(find.text('Recorded by the school on your behalf.'), findsOneWidget);
    expect(
      find.text("Waiting for the school to add a place. Student AI starts once it's added."),
      findsOneWidget,
    );
    expect(find.text('Waiting for the school'), findsOneWidget);
    expectNoPrice();
    expect(find.byType(Checkbox), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
    expect(find.textContaining(RegExp('cancel', caseSensitive: false)), findsNothing);
    expect(find.textContaining(RegExp('undo', caseSensitive: false)), findsNothing);
  });

  testWidgets('a released seat shows the opt-in as ended', (tester) async {
    await _pump(
      tester,
      _FakeStudentAiClient(
        offersOf([
          optedInOfferJson(
            id: 'child-1',
            name: 'Amir',
            status: 'released',
            releasedEffectiveMonth: '2027-01-01',
          ),
        ]),
      ),
    );

    expect(find.text('Student AI for Amir has ended.'), findsOneWidget);
    expect(find.text('The school ended it. It stops from January 2027.'), findsOneWidget);
    expect(find.text('Ended'), findsOneWidget);
  });

  testWidgets('nothing offered: the screen says so', (tester) async {
    await _pump(tester, _FakeStudentAiClient(offersOf(const [])));

    expect(find.text("Student AI isn't offered for your children at this school."), findsOneWidget);
  });

  testWidgets('every state reads in Arabic, with no untranslated keys', (tester) async {
    await _pump(
      tester,
      _FakeStudentAiClient(
        offersOf([
          availableOfferJson(id: 'child-1', name: 'Amir'),
          optedInOfferJson(id: 'child-2', name: 'Lina', waitingForSchool: true),
          closedOfferJson(id: 'child-3', name: 'Omar'),
        ]),
      ),
      locale: const Locale('ar'),
    );

    expect(find.text('Student AI لـAmir'), findsOneWidget);
    expect(find.text('الانضمام إلى Student AI مغلق في Alpha Academy حاليًا.'), findsOneWidget);
    expect(find.text('تقدّمه مدرستك'), findsOneWidget);
    expect(find.text('ستُخبرك مدرستك بالسعر.'), findsOneWidget);
    expect(find.textContaining('studentAiOptIn.'), findsNothing);
    expect(find.textContaining(RegExp(r'[$€£]|\d+[.,]\d{2}|×')), findsNothing);
  });

  group('home card', () {
    testWidgets('summarises each child and opens the Student AI screen', (tester) async {
      await _pump(
        tester,
        _FakeStudentAiClient(
          offersOf([
            availableOfferJson(id: 'child-1', name: 'Amir'),
            optedInOfferJson(id: 'child-2', name: 'Lina', startMonth: '2026-11-01'),
          ]),
        ),
        home: const Scaffold(body: StudentAiHomeCard()),
      );

      expect(find.byKey(const Key('studentAiHomeCard')), findsOneWidget);
      expect(find.text('Amir'), findsOneWidget);
      expect(find.text('Lina'), findsOneWidget);
      expect(find.text('Available'), findsOneWidget);
      expect(find.text('Confirmed'), findsOneWidget);

      await tester.tap(find.text('Amir'));
      await tester.pumpAndSettle();
      expect(find.byType(StudentAiOptInScreen), findsOneWidget);
      expect(find.text('From September 2026 to April 2027'), findsOneWidget);
      expect(
        find.text('From November 2026 to April 2027 · Included in your school fees'),
        findsOneWidget,
      );
      expectNoPrice();
    });

    testWidgets('is hidden when the school offered Student AI to no child', (tester) async {
      await _pump(
        tester,
        _FakeStudentAiClient(offersOf(const [])),
        home: const Scaffold(body: StudentAiHomeCard()),
      );

      expect(find.byKey(const Key('studentAiHomeCard')), findsNothing);
    });
  });
}
