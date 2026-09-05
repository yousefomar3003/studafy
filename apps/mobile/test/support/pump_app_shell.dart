import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/auth/auth_providers.dart';
import 'package:studafy_mobile/src/core/auth/auth_session.dart';
import 'package:studafy_mobile/src/core/config/app_config.dart';
import 'package:studafy_mobile/src/core/config/app_environment.dart';
import 'package:studafy_mobile/src/core/di/app_providers.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/shell/presentation/app_shell.dart';

import 'wrap_with_localization.dart';

/// Pumps [AppShell] directly against an authenticated [session] — no [GoRouter], no login
/// flow — the right altitude for the shell's own behavior (which role's destinations render,
/// the view-only banner, mutation affordances, tab-switch state). Router/auth-guard
/// integration is covered separately in `test/core/router/`.
Future<void> pumpAppShell(
  WidgetTester tester, {
  required AuthSession session,
  Locale startLocale = AppLocales.fallback,
}) async {
  await tester.pumpWidget(
    KeyedSubtree(
      key: UniqueKey(),
      child: wrapWithLocalization(
        ProviderScope(
          overrides: [
            authSessionProvider.overrideWithValue(session),
            // `shellRoleProvider` -> `authNotifierProvider` builds `authClientProvider`
            // regardless of `authSessionProvider` being overridden — it reads `appConfigProvider`
            // for its base URL since ST-247's fix to that hardcoded-localhost bug, so this needs
            // a value the same way `pumpStudafyApp` already provides one.
            appConfigProvider.overrideWithValue(AppConfig.fromEnvironment(AppEnvironment.dev)),
          ],
          child: Builder(
            builder: (context) {
              return MaterialApp(
                theme: AppTheme.light,
                debugShowCheckedModeBanner: false,
                locale: context.locale,
                supportedLocales: context.supportedLocales,
                localizationsDelegates: context.localizationDelegates,
                home: const AppShell(),
              );
            },
          ),
        ),
        startLocale: startLocale,
      ),
    ),
  );
  await tester.pumpAndSettle();
}
