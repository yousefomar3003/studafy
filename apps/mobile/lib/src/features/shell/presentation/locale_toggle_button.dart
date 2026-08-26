import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../core/localization/app_locales.dart';

/// AppBar action that switches between the app's supported locales.
///
/// Shows the *other* locale's own native name (tapping it switches to that locale) — a
/// language names itself, so this isn't translated, matching the web app's locale switcher
/// convention.
class LocaleToggleButton extends StatelessWidget {
  const LocaleToggleButton({super.key});

  @override
  Widget build(BuildContext context) {
    final current = context.locale;
    final next = AppLocales.supported.firstWhere((locale) => locale != current);

    return TextButton(
      onPressed: () => context.setLocale(next),
      child: Text(
        AppLocales.nativeNames[next] ?? next.languageCode,
        semanticsLabel: 'shell.switchLanguage'.tr(),
      ),
    );
  }
}
