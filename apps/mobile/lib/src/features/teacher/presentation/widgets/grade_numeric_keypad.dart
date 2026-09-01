import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// A docked numeric keypad for rapid score entry — large, evenly spaced keys so a teacher can
/// run through a whole roster with their thumb without the row list ever being covered by the OS
/// keyboard. The wide action key commits the current value and advances to the next student
/// ([onNext]); on the last row it reads as "Done" and just dismisses the keypad.
class GradeNumericKeypad extends StatelessWidget {
  const GradeNumericKeypad({
    required this.onDigit,
    required this.onDot,
    required this.onBackspace,
    required this.onClear,
    required this.onNext,
    required this.isLastRow,
    super.key,
  });

  final ValueChanged<String> onDigit;
  final VoidCallback onDot;
  final VoidCallback onBackspace;
  final VoidCallback onClear;
  final VoidCallback onNext;
  final bool isLastRow;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Material(
      elevation: 3,
      color: theme.colorScheme.surface,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final row in const [
                ['7', '8', '9'],
                ['4', '5', '6'],
                ['1', '2', '3'],
              ])
                Row(
                  children: [
                    for (final key in row) _Key(label: key, onTap: () => onDigit(key)),
                  ],
                ),
              Row(
                children: [
                  _Key(label: '.', onTap: onDot),
                  _Key(label: '0', onTap: () => onDigit('0')),
                  _Key(
                    icon: Icons.backspace_outlined,
                    onTap: onBackspace,
                    onLongPress: onClear,
                    semanticLabel: 'teacher.grades.keypad.backspace'.tr(),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.space4),
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: onNext,
                  icon: Icon(isLastRow ? Icons.check : Icons.arrow_downward),
                  label: Text(
                    (isLastRow ? 'teacher.grades.keypad.done' : 'teacher.grades.keypad.next').tr(),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Key extends StatelessWidget {
  const _Key({
    this.label,
    this.icon,
    required this.onTap,
    this.onLongPress,
    this.semanticLabel,
  });

  final String? label;
  final IconData? icon;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Expanded(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space4),
        child: Semantics(
          label: semanticLabel,
          button: true,
          child: InkWell(
            borderRadius: AppRadius.mdRadius,
            onTap: () {
              HapticFeedback.selectionClick();
              onTap();
            },
            onLongPress: onLongPress,
            child: Container(
              height: 52,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                borderRadius: AppRadius.mdRadius,
                color: theme.colorScheme.surfaceContainerHighest,
              ),
              child: icon != null
                  ? Icon(icon, size: 22)
                  : Text(
                      label!,
                      style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600),
                    ),
            ),
          ),
        ),
      ),
    );
  }
}
