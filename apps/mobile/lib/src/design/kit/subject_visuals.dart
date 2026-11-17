import 'package:flutter/material.dart';

import '../tokens/app_accent_tokens.dart';

/// A subject's or class's accent hue and icon.
@immutable
class SubjectVisual {
  const SubjectVisual({required this.accent, required this.icon});

  final AppAccent accent;
  final IconData icon;

  @override
  bool operator ==(Object other) =>
      other is SubjectVisual && other.accent == accent && other.icon == icon;

  @override
  int get hashCode => Object.hash(accent, icon);
}

/// Gives each subject or class a consistent accent colour and icon, so "Mathematics" is the same
/// blue calculator on the timetable, the grades card and the class list.
///
/// [of] reads the subject from a course name ("Mathematics", "الرياضيات") or a class code
/// ("MATH101-A"), in English or Arabic. A name it doesn't recognise still gets a stable colour,
/// hashed from the text, and a generic icon — never a random one, so the same class looks the same
/// on every screen and every launch.
abstract final class SubjectVisuals {
  static const IconData fallbackIcon = Icons.class_outlined;

  /// The visual for [name], falling back to [fallbackKey] (e.g. a class id) for the hashed colour
  /// when [name] is empty or unknown.
  static SubjectVisual of(String? name, {String? fallbackKey}) {
    final text = (name ?? '').trim();
    final match = _match(text);
    if (match != null) return match;
    final key = text.isNotEmpty ? text : (fallbackKey ?? '');
    return SubjectVisual(accent: accentForKey(key), icon: fallbackIcon);
  }

  /// A stable accent for any key (class id, code, name): the same key always gets the same hue.
  static AppAccent accentForKey(String key) {
    const hues = AppAccent.subjectHues;
    return hues[_fnv1a(key.toLowerCase()) % hues.length];
  }

  static SubjectVisual? _match(String text) {
    if (text.isEmpty) return null;
    final lower = text.toLowerCase();
    final tokens = lower
        .split(RegExp(r'[^\p{L}]+', unicode: true))
        .where((token) => token.isNotEmpty)
        .toList();
    for (final rule in _rules) {
      if (rule.matches(lower, tokens)) return rule.visual;
    }
    return null;
  }

  // Order matters: the more specific rule wins ("physical education" is PE, not physics;
  // "رياضيات" is maths, "رياضة" is sport).
  static const _rules = <_SubjectRule>[
    _SubjectRule(
      SubjectVisual(accent: AppAccent.teal, icon: Icons.sports_soccer_outlined),
      exact: {
        'pe',
        'sport',
        'sports',
        'physical',
        'gym',
        'fitness',
        'athletics',
      },
      arabic: ['رياضة', 'رياضية', 'بدنية'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.blue, icon: Icons.calculate_outlined),
      prefixes: [
        'math',
        'algebra',
        'geometr',
        'calculus',
        'statistic',
        'arithmetic',
      ],
      arabic: ['رياضيات', 'جبر', 'إحصاء', 'احصاء', 'حساب'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.indigo, icon: Icons.bolt_outlined),
      prefixes: ['phys'],
      arabic: ['فيزياء'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.violet, icon: Icons.science_outlined),
      prefixes: ['chem'],
      arabic: ['كيمياء'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.emerald, icon: Icons.biotech_outlined),
      prefixes: ['bio'],
      arabic: ['أحياء', 'احياء'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.teal, icon: Icons.science_outlined),
      prefixes: ['scien'],
      exact: {'sci'},
      arabic: ['علوم'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.cyan, icon: Icons.computer_outlined),
      prefixes: [
        'comput',
        'program',
        'coding',
        'robot',
        'technolog',
        'informati',
      ],
      exact: {'it', 'ict', 'cs', 'tech'},
      arabic: ['حاسوب', 'حاسب', 'تكنولوجيا', 'برمجة', 'معلوماتية'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.amber, icon: Icons.translate_outlined),
      prefixes: ['arab'],
      arabic: ['عربي', 'العربية'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.rose, icon: Icons.menu_book_outlined),
      prefixes: [
        'english',
        'eng',
        'literat',
        'language',
        'reading',
        'writing',
        'french',
        'spanish',
        'german',
      ],
      arabic: ['إنجليزي', 'انجليزي', 'الإنجليزية', 'لغة', 'فرنسي', 'أدب'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.orange, icon: Icons.history_edu_outlined),
      prefixes: ['hist', 'social', 'civic', 'citizen'],
      arabic: ['تاريخ', 'اجتماعيات', 'اجتماعية', 'وطنية'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.cyan, icon: Icons.public_outlined),
      prefixes: ['geog'],
      exact: {'geo'},
      arabic: ['جغرافيا'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.fuchsia, icon: Icons.palette_outlined),
      prefixes: ['art', 'drawing', 'design', 'craft'],
      arabic: ['فنون', 'الفن', 'فنية', 'الرسم'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.violet, icon: Icons.music_note_outlined),
      prefixes: ['music'],
      exact: {'mus'},
      arabic: ['موسيقى'],
    ),
    _SubjectRule(
      SubjectVisual(
        accent: AppAccent.emerald,
        icon: Icons.auto_stories_outlined,
      ),
      prefixes: ['islam', 'relig', 'quran', 'ethic'],
      arabic: ['إسلامية', 'اسلامية', 'دينية', 'الدين', 'قرآن', 'قران', 'شريعة'],
    ),
    _SubjectRule(
      SubjectVisual(accent: AppAccent.indigo, icon: Icons.trending_up),
      prefixes: ['econ', 'business', 'account', 'financ', 'commerce'],
      arabic: ['اقتصاد', 'محاسبة', 'إدارة', 'تجارة'],
    ),
  ];

  /// 32-bit FNV-1a: [String.hashCode] isn't guaranteed stable across runs or platforms.
  static int _fnv1a(String text) {
    var hash = 0x811c9dc5;
    for (final unit in text.codeUnits) {
      hash ^= unit;
      hash = (hash * 0x01000193) & 0xFFFFFFFF;
    }
    return hash;
  }
}

class _SubjectRule {
  const _SubjectRule(
    this.visual, {
    this.prefixes = const [],
    this.exact = const {},
    this.arabic = const [],
  });

  final SubjectVisual visual;

  /// Latin word starts: "math" matches "Mathematics" and "MATH101".
  final List<String> prefixes;

  /// Whole Latin words only, for keywords too short to match as a prefix ("pe", "it").
  final Set<String> exact;

  /// Arabic substrings, so a prefixed form ("الرياضيات") still matches.
  final List<String> arabic;

  bool matches(String lower, List<String> tokens) {
    for (final token in tokens) {
      if (exact.contains(token)) return true;
      for (final prefix in prefixes) {
        if (token.startsWith(prefix)) return true;
      }
    }
    for (final word in arabic) {
      if (lower.contains(word)) return true;
    }
    return false;
  }
}
