import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';

import '../../../../design/tokens/app_radius_tokens.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';

/// The unsubscribed state: a locked hero saying the AI Study Assistant needs an active
/// subscription, then what it includes. The AI tools themselves stay hidden until the add-on is
/// active. Where the store sells it to this student, `AiStoreOfferCard` (`../../store/`) follows
/// with the App Store / Google Play purchase; where the school would cover it, the "ask your
/// school" notice does. This card itself carries no button, link, price or mention of the website —
/// both stores forbid steering to a purchase outside their own billing (ST-304; see
/// `apps/mobile/docs/store_payment_routing.md`, pinned by
/// `test/store_compliance/payment_routing_test.dart`). An add-on activated elsewhere shows up on
/// the next resume or pull-to-refresh (`AiHubScreen`).
class AiNotActiveCard extends StatelessWidget {
  const AiNotActiveCard({super.key});

  static const _included = [
    (Icons.chat_bubble_outline, 'ask'),
    (Icons.quiz_outlined, 'practice'),
    (Icons.summarize_outlined, 'summaries'),
    (Icons.assignment_outlined, 'exam'),
  ];

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: colorScheme.surface,
        borderRadius: const BorderRadius.all(Radius.circular(AppRadius.xl + AppRadius.md)),
        border: Border.all(color: colorScheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.space20,
              AppSpacing.space24,
              AppSpacing.space20,
              AppSpacing.space20,
            ),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: AlignmentDirectional.topStart,
                end: AlignmentDirectional.bottomEnd,
                colors: [colorScheme.primaryContainer, colorScheme.surface],
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const _LockedBadgeIcon(),
                const SizedBox(height: AppSpacing.space16),
                _RequiredChip(label: 'ai.notActive.badge'.tr()),
                const SizedBox(height: AppSpacing.space12),
                Text(
                  'ai.notActive.title'.tr(),
                  style: textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: AppSpacing.space8),
                Text(
                  'ai.notActive.body'.tr(),
                  style: textTheme.bodyMedium?.copyWith(color: colorScheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.space20,
              AppSpacing.space8,
              AppSpacing.space20,
              AppSpacing.space20,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'ai.notActive.includedTitle'.tr(),
                  style: textTheme.labelLarge?.copyWith(color: colorScheme.onSurfaceVariant),
                ),
                const SizedBox(height: AppSpacing.space12),
                for (final (icon, key) in _included) ...[
                  _IncludedFeature(
                    icon: icon,
                    title: 'ai.notActive.features.$key.title'.tr(),
                    body: 'ai.notActive.features.$key.body'.tr(),
                  ),
                  if (key != _included.last.$2) const SizedBox(height: AppSpacing.space12),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The AI sparkle in a filled circle, with a small lock on its corner.
class _LockedBadgeIcon extends StatelessWidget {
  const _LockedBadgeIcon();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: 64,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Container(
              decoration: BoxDecoration(color: colorScheme.primary, shape: BoxShape.circle),
              alignment: Alignment.center,
              child: Icon(Icons.auto_awesome, size: 30, color: colorScheme.onPrimary),
            ),
            PositionedDirectional(
              end: -2,
              bottom: -2,
              child: Container(
                padding: const EdgeInsets.all(AppSpacing.space4),
                decoration: BoxDecoration(
                  color: colorScheme.inverseSurface,
                  shape: BoxShape.circle,
                  border: Border.all(color: colorScheme.surface, width: 2),
                ),
                child: Icon(Icons.lock, size: 14, color: colorScheme.onInverseSurface),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RequiredChip extends StatelessWidget {
  const _RequiredChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space12,
        vertical: AppSpacing.space4,
      ),
      decoration: BoxDecoration(
        color: colorScheme.primary.withValues(alpha: 0.12),
        borderRadius: AppRadius.fullRadius,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.lock_outline, size: 14, color: colorScheme.primary),
          const SizedBox(width: AppSpacing.space4),
          Text(
            label,
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
              color: colorScheme.primary,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _IncludedFeature extends StatelessWidget {
  const _IncludedFeature({required this.icon, required this.title, required this.body});

  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: colorScheme.primaryContainer,
            borderRadius: AppRadius.lgRadius,
          ),
          child: Icon(icon, size: 20, color: colorScheme.onPrimaryContainer),
        ),
        const SizedBox(width: AppSpacing.space12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: textTheme.titleSmall),
              const SizedBox(height: 2),
              Text(body, style: textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant)),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsetsDirectional.only(
            start: AppSpacing.space8,
            top: AppSpacing.space8,
          ),
          child: Icon(Icons.lock_outline, size: 16, color: colorScheme.outline),
        ),
      ],
    );
  }
}
