import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/generated/models/platform_announcement_severity.dart';
import 'package:studafy_mobile/src/core/api/generated/models/platform_banner.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/shell/application/platform_banner_providers.dart';
import 'package:studafy_mobile/src/features/shell/presentation/platform_banner.dart';

import '../../support/wrap_with_localization.dart';

final _ends = DateTime.utc(2030, 1, 1);

final _maintenance = PlatformBanner(
  id: '33333333-3333-4333-8333-333333333333',
  messageEn: 'Maintenance tonight',
  messageAr: 'صيانة الليلة',
  severity: PlatformAnnouncementSeverity.maintenance,
  dismissible: false,
  endsAt: _ends,
);

final _info = PlatformBanner(
  id: '44444444-4444-4444-8444-444444444444',
  messageEn: 'New report cards are live',
  messageAr: null,
  severity: PlatformAnnouncementSeverity.info,
  dismissible: true,
  endsAt: _ends,
);

Widget _app(List<PlatformBanner> banners) {
  return ProviderScope(
    overrides: [platformBannersProvider.overrideWith((ref) async => banners)],
    child: Builder(
      builder: (context) => MaterialApp(
        theme: AppTheme.light,
        debugShowCheckedModeBanner: false,
        locale: context.locale,
        supportedLocales: context.supportedLocales,
        localizationsDelegates: context.localizationDelegates,
        home: const Scaffold(body: PlatformBannerStrip()),
      ),
    ),
  );
}

void main() {
  testWidgets(
    'shows live banners; only the non-maintenance one can be dismissed',
    (tester) async {
      await tester.pumpWidget(
        wrapWithLocalization(_app([_maintenance, _info])),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Maintenance tonight'), findsOneWidget);
      expect(find.textContaining('New report cards are live'), findsOneWidget);
      final dismiss = find.byTooltip('shell.platformBanner.dismiss'.tr());
      expect(dismiss, findsOneWidget);

      await tester.tap(dismiss);
      await tester.pumpAndSettle();

      expect(find.textContaining('New report cards are live'), findsNothing);
      expect(find.textContaining('Maintenance tonight'), findsOneWidget);
    },
  );

  testWidgets('shows the Arabic message when the app is in Arabic', (
    tester,
  ) async {
    await tester.pumpWidget(
      wrapWithLocalization(
        _app([_maintenance]),
        startLocale: const Locale('ar'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('صيانة الليلة'), findsOneWidget);
  });

  testWidgets('renders nothing without banners', (tester) async {
    await tester.pumpWidget(wrapWithLocalization(_app(const [])));
    await tester.pumpAndSettle();

    expect(find.byType(IconButton), findsNothing);
    expect(find.byType(Icon), findsNothing);
  });
}
