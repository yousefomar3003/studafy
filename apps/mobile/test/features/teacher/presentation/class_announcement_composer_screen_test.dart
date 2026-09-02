import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/api/generated/models/create_announcement_body_audience_type.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/teacher/presentation/class_announcement_composer_screen.dart';

import '../../../support/ensure_date_formatting.dart';
import '../../../support/wrap_with_localization.dart';
import '../support.dart';

Widget _app() => Builder(
      builder: (context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        locale: context.locale,
        supportedLocales: context.supportedLocales,
        localizationsDelegates: context.localizationDelegates,
        theme: AppTheme.light,
        home: const ClassAnnouncementComposerScreen(
          classId: 'class-1',
          classCode: 'MATH101-A',
        ),
      ),
    );

Future<void> _pump(WidgetTester tester, FakeStudafyApiClient api) {
  return tester.pumpWidget(
    wrapWithLocalization(
      ProviderScope(
        overrides: [apiClientProvider.overrideWithValue(api)],
        child: _app(),
      ),
    ),
  );
}

void main() {
  setUpAll(ensureDateFormattingInitialized);

  testWidgets('sends a non-mandatory class-scoped announcement for this class', (tester) async {
    final announcements = FakeAnnouncementsClient()..recipientCount = 24;
    await _pump(tester, FakeStudafyApiClient(announcements: announcements));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(0), 'Field trip');
    await tester.enterText(find.byType(TextFormField).at(1), 'Slips due Monday.');
    await tester.tap(find.text('Send announcement'));
    await tester.pumpAndSettle();

    expect(announcements.createCalls, hasLength(1));
    final body = announcements.createCalls.single;
    expect(body.title, 'Field trip');
    expect(body.body, 'Slips due Monday.');
    expect(body.mandatory, isFalse);
    expect(body.audienceType, CreateAnnouncementBodyAudienceType.valueClass);
    expect(body.audienceClassId, 'class-1');
  });

  testWidgets('blocks an empty submission without calling the API', (tester) async {
    final announcements = FakeAnnouncementsClient();
    await _pump(tester, FakeStudafyApiClient(announcements: announcements));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Send announcement'));
    await tester.pumpAndSettle();

    expect(announcements.createCalls, isEmpty);
    expect(find.text('Give the announcement a title.'), findsOneWidget);
    expect(find.text('Write a message.'), findsOneWidget);
  });

  testWidgets('surfaces the scoped-forbidden error from the API', (tester) async {
    final announcements = FakeAnnouncementsClient()
      ..throwOnCreate = DioException(
        requestOptions: RequestOptions(path: '/api/announcements'),
        error: const ApiException(
          status: 403,
          title: 'Forbidden',
          code: 'ANNOUNCEMENT_SCOPE_FORBIDDEN',
        ),
      );
    await _pump(tester, FakeStudafyApiClient(announcements: announcements));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextFormField).at(0), 'Anything');
    await tester.enterText(find.byType(TextFormField).at(1), 'Body text.');
    await tester.tap(find.text('Send announcement'));
    await tester.pumpAndSettle();

    expect(find.text('You can only announce to classes you teach.'), findsOneWidget);
  });
}
