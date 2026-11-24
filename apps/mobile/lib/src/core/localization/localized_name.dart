import 'package:easy_localization/easy_localization.dart' hide TextDirection;
import 'package:flutter/widgets.dart';

/// Arabic names (API 000264). Schools may keep an Arabic spelling beside the English name of a
/// student, subject, grade, section, term, year and the school itself. Screens pass both through
/// these helpers instead of choosing ad hoc, so every screen falls back the same way: an absent
/// or blank Arabic name (an older server, or a school that keeps none) shows the English one.

/// A non-blank Arabic name, or null.
String? arabicNameOf(Object? value) =>
    value is String && value.trim().isNotEmpty ? value.trim() : null;

/// The Arabic spelling when the app is in Arabic and there is one; otherwise [name].
String pickLocalizedName(String languageCode, String name, String? nameAr) {
  final arabic = arabicNameOf(nameAr);
  return languageCode == 'ar' && arabic != null ? arabic : name;
}

extension LocalizedNameContext on BuildContext {
  /// The name to show here: inside an issued document ([DocumentLanguageScope]) the document's
  /// spelling, elsewhere [pickLocalizedName] for the app's current language.
  String localizedName(String name, String? nameAr) {
    final scope = DocumentLanguageScope.maybeOf(this);
    return scope == null
        ? pickLocalizedName(locale.languageCode, name, nameAr)
        : documentName(scope.language, locale.languageCode, name, nameAr);
  }
}

/// Marks a subtree as an issued document in [language]: names inside follow the document (see
/// [LocalizedNameContext.localizedName]), and an Arabic or English document lays out in its own
/// direction whatever the app's.
class DocumentLanguageScope extends InheritedWidget {
  DocumentLanguageScope({
    required this.language,
    required Widget child,
    super.key,
  }) : super(
         child: switch (documentDirection(language)) {
           final direction? => Directionality(
             textDirection: direction,
             child: child,
           ),
           null => child,
         },
       );

  final DocumentLanguage? language;

  static DocumentLanguageScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<DocumentLanguageScope>();

  @override
  bool updateShouldNotify(DocumentLanguageScope oldWidget) =>
      oldWidget.language != language;
}

/// The language a school issued a report card, certificate or transcript in. A document without
/// one (issued before, or left to each reader) follows the app's language, as it always did; an
/// unknown value from a newer server degrades the same way.
enum DocumentLanguage {
  en,
  ar,
  bilingual;

  static DocumentLanguage? fromWire(Object? value) => switch (value) {
    'en' => en,
    'ar' => ar,
    'bilingual' => bilingual,
    _ => null,
  };
}

/// The name an issued document shows: its language's spelling (both on a bilingual document), or
/// the reader's when it has no language.
String documentName(
  DocumentLanguage? language,
  String readerLanguageCode,
  String name,
  String? nameAr,
) {
  final arabic = arabicNameOf(nameAr);
  return switch (language) {
    DocumentLanguage.en => name,
    DocumentLanguage.ar => arabic ?? name,
    DocumentLanguage.bilingual =>
      arabic == null || arabic == name ? name : '$name / $arabic',
    null => pickLocalizedName(readerLanguageCode, name, arabic),
  };
}

/// Right to left for an Arabic document, left to right for an English one; null keeps the app's.
TextDirection? documentDirection(DocumentLanguage? language) =>
    switch (language) {
      DocumentLanguage.ar => TextDirection.rtl,
      DocumentLanguage.en => TextDirection.ltr,
      _ => null,
    };

/// A student's Arabic full name from the API's `first_name_ar` / `middle_name_ar` /
/// `last_name_ar`, or null when there is none.
String? studentArabicName(Map<String, Object?> student) {
  final parts = [
    for (final key in const ['first_name_ar', 'middle_name_ar', 'last_name_ar'])
      ?arabicNameOf(student[key]),
  ];
  return parts.isEmpty ? null : parts.join(' ');
}
