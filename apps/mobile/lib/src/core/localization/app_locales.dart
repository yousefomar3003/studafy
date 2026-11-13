import 'package:flutter/widgets.dart';

/// The set of locales the mobile app ships UI translations for.
///
/// Kept in lockstep with the web app's `SUPPORTED_LOCALES`
/// (`apps/web/src/lib/i18n/config.ts`) by convention, not by import — the two apps don't share a
/// package for this, so adding a locale means updating both lists.
abstract final class AppLocales {
  static const supported = [Locale('en'), Locale('ar')];

  static const fallback = Locale('en');

  /// Folder `easy_localization` loads `<languageCode>.json` translation files from.
  static const translationsPath = 'assets/translations';

  /// Native-script display name, for the language switcher. Not translated — a language names
  /// itself, same convention as the web app's `LOCALE_LABELS`.
  ///
  /// Not `const`: [Locale] overrides `==`/`hashCode`, which the language disallows as a const
  /// map key even though the values themselves never change at runtime.
  static final nativeNames = {const Locale('en'): 'English', const Locale('ar'): 'العربية'};
}
