import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/widgets.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';

/// Wraps [child] with the same [EasyLocalization] configuration `bootstrapApp` uses, so widget
/// and golden tests get working `.tr()` calls and locale switching without duplicating that
/// setup per test file.
///
/// [startLocale] pins the initial locale explicitly instead of falling back to the host
/// machine's device locale, which `flutter test` can't control and shouldn't need to.
Widget wrapWithLocalization(Widget child, {Locale startLocale = AppLocales.fallback}) {
  return EasyLocalization(
    supportedLocales: AppLocales.supported,
    path: AppLocales.translationsPath,
    fallbackLocale: AppLocales.fallback,
    startLocale: startLocale,
    child: child,
  );
}
