import 'package:flutter/material.dart';

import '../tokens/app_accent_tokens.dart';
import '../tokens/app_spacing_tokens.dart';
import 'app_card_surface.dart';
import 'app_section_header.dart';

/// A dashboard card: an [AppSectionHeader] (coloured icon badge, bold title, optional trailing
/// count or action) over a body [child] — the template every home-screen section is built on.
class AppSectionCard extends StatelessWidget {
  const AppSectionCard({
    required this.title,
    required this.icon,
    required this.child,
    this.accent = AppAccent.blue,
    this.subtitle,
    this.trailing,
    super.key,
  });

  final String title;
  final IconData icon;
  final Widget child;
  final AppAccent accent;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return AppCardSurface(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AppSectionHeader(
              title: title,
              icon: icon,
              accent: accent,
              subtitle: subtitle,
              trailing: trailing,
            ),
            const SizedBox(height: AppSpacing.space12),
            child,
          ],
        ),
      ),
    );
  }
}

/// An [AppSectionCard] whose body folds away under its header: tap the header to collapse or
/// expand it. The header announces its expanded state to screen readers.
///
/// Uncontrolled by default: the card keeps its own state, starting from [initiallyExpanded]. Give
/// it [expanded] to control it instead (e.g. state restored from storage after the first frame);
/// a tap then only reports the wanted state through [onExpansionChanged].
class AppCollapsibleSectionCard extends StatefulWidget {
  const AppCollapsibleSectionCard({
    required this.title,
    required this.icon,
    required this.child,
    this.accent = AppAccent.blue,
    this.subtitle,
    this.trailing,
    this.initiallyExpanded = true,
    this.expanded,
    this.onExpansionChanged,
    super.key,
  });

  final String title;
  final IconData icon;
  final Widget child;
  final AppAccent accent;
  final String? subtitle;

  /// Shown before the expand chevron (e.g. a count that stays visible while collapsed).
  final Widget? trailing;
  final bool initiallyExpanded;

  /// When non-null, whether the card is expanded; the parent owns the state.
  final bool? expanded;
  final ValueChanged<bool>? onExpansionChanged;

  @override
  State<AppCollapsibleSectionCard> createState() =>
      _AppCollapsibleSectionCardState();
}

class _AppCollapsibleSectionCardState extends State<AppCollapsibleSectionCard> {
  late bool _ownExpanded = widget.initiallyExpanded;

  static const _duration = Duration(milliseconds: 200);

  bool get _expanded => widget.expanded ?? _ownExpanded;

  void _toggle() {
    final next = !_expanded;
    if (widget.expanded == null) setState(() => _ownExpanded = next);
    widget.onExpansionChanged?.call(next);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;

    return AppCardSurface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            button: true,
            expanded: _expanded,
            child: InkWell(
              onTap: _toggle,
              child: Padding(
                padding: const EdgeInsets.all(AppSpacing.space16),
                child: AppSectionHeader(
                  title: widget.title,
                  icon: widget.icon,
                  accent: widget.accent,
                  subtitle: widget.subtitle,
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ?widget.trailing,
                      AnimatedRotation(
                        turns: _expanded ? 0.5 : 0,
                        duration: _duration,
                        child: Icon(
                          Icons.expand_more,
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          AnimatedSize(
            duration: _duration,
            curve: Curves.easeOutCubic,
            alignment: AlignmentDirectional.topStart,
            child: _expanded
                ? Padding(
                    padding: const EdgeInsetsDirectional.fromSTEB(
                      AppSpacing.space16,
                      0,
                      AppSpacing.space16,
                      AppSpacing.space16,
                    ),
                    child: widget.child,
                  )
                : const SizedBox(width: double.infinity),
          ),
        ],
      ),
    );
  }
}
