import 'dart:convert';
import 'dart:io';

import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/widgets.dart';
import 'package:studafy_mobile/src/core/localization/app_locales.dart';

/// Wraps [child] with the same [EasyLocalization] configuration `bootstrapApp` uses, so widget
/// and golden tests get working `.tr()` calls and locale switching without duplicating that
/// setup per test file.
///
/// [startLocale] pins the initial locale explicitly instead of falling back to the host
/// machine's device locale, which `flutter test` can't control and shouldn't need to.
///
/// Translations are read from disk by [FileTranslationsLoader] rather than through
/// `rootBundle`: `rootBundle.loadString` decodes any asset over 50 KB on a background isolate
/// (`compute`), which never completes inside a widget test's fake-async zone.
Widget wrapWithLocalization(
  Widget child, {
  Locale startLocale = AppLocales.fallback,
}) {
  return EasyLocalization(
    supportedLocales: AppLocales.supported,
    path: AppLocales.translationsPath,
    fallbackLocale: AppLocales.fallback,
    startLocale: startLocale,
    assetLoader: const FileTranslationsLoader(),
    child: child,
  );
}

/// Loads `<path>/<locale>.json` synchronously from the package directory (`flutter test`'s
/// working directory) — the same files `RootBundleAssetLoader` serves from the asset bundle.
class FileTranslationsLoader extends AssetLoader {
  const FileTranslationsLoader();

  @override
  Future<Map<String, dynamic>?> load(String path, Locale locale) async {
    final file = File(
      '$path/${locale.toStringWithSeparator(separator: '-')}.json',
    );
    return json.decode(file.readAsStringSync()) as Map<String, dynamic>;
  }
}
