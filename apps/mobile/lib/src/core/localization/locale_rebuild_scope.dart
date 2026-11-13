import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/widgets.dart';

/// Rebuilds its whole subtree when the app locale changes, so every `'key'.tr()` re-resolves.
///
/// `tr()` without a `context` reads the active translations but registers no dependency, so a
/// widget whose inputs didn't change (the shell's tab labels, any `const` screen) keeps its old
/// strings after `context.setLocale` — the layout flips to RTL (that comes from `Directionality`)
/// while the text stays in the previous language. Marking every descendant dirty once per locale
/// switch fixes that app-wide without converting each call site to `context.tr()`, and unlike
/// re-keying the tree it keeps all widget state (selected tab, scroll positions, form input).
///
/// Mount it inside `MaterialApp.builder` so the Navigator and every route are descendants.
class LocaleRebuildScope extends StatefulWidget {
  const LocaleRebuildScope({super.key, required this.child});

  final Widget child;

  @override
  State<LocaleRebuildScope> createState() => _LocaleRebuildScopeState();
}

class _LocaleRebuildScopeState extends State<LocaleRebuildScope> {
  Locale? _locale;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final locale = context.locale;
    if (_locale != null && _locale != locale) {
      // After this frame: dirtying descendants while their ancestor is mid-build is not allowed.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) (context as Element).visitChildren(_markNeedsBuild);
      });
    }
    _locale = locale;
  }

  static void _markNeedsBuild(Element element) {
    element.markNeedsBuild();
    element.visitChildren(_markNeedsBuild);
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
