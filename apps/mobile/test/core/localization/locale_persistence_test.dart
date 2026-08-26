// `intl` (re-exported by easy_localization) declares its own `TextDirection`, which would
// otherwise shadow Flutter's — this test only wants Flutter's, for `Directionality`.
import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';

/// Verifies the AC that a locale switch survives — device-level persistence, the same
/// deliberate scope line the web app's `lib/i18n/store.ts` documents: there is no per-user
/// server-side language preference, only a persisted choice for this install.
void main() {
  testWidgets('setting a locale persists it for the next EasyLocalization startup',
      (tester) async {
    // Start clean: no saved locale yet, so the app boots on its fallback.
    SharedPreferences.setMockInitialValues({});
    await EasyLocalization.ensureInitialized();

    await tester.pumpWidget(
      EasyLocalization(
        supportedLocales: AppLocales.supported,
        path: AppLocales.translationsPath,
        fallbackLocale: AppLocales.fallback,
        child: const _LocaleProbe(),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('en'), findsOneWidget);

    final probeContext = tester.element(find.byType(_LocaleProbe));
    await probeContext.setLocale(const Locale('ar'));
    await tester.pumpAndSettle();
    expect(find.text('ar'), findsOneWidget);

    // Simulate an app restart: a fresh `ensureInitialized()` re-reads the persisted locale
    // from (fake) device storage, and a brand new `EasyLocalization` tree starts from it
    // instead of the fallback.
    await EasyLocalization.ensureInitialized();

    await tester.pumpWidget(
      KeyedSubtree(
        key: UniqueKey(),
        child: EasyLocalization(
          supportedLocales: AppLocales.supported,
          path: AppLocales.translationsPath,
          fallbackLocale: AppLocales.fallback,
          child: const _LocaleProbe(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('ar'), findsOneWidget);
  });
}

class _LocaleProbe extends StatelessWidget {
  const _LocaleProbe();

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.ltr,
      child: Text(context.locale.languageCode),
    );
  }
}
