import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/platform_announcement_severity.dart';
import '../../../core/api/generated/models/platform_banner.dart';
import '../../../design/theme/app_semantic_colors.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/platform_banner_providers.dart';

/// The Studafy-wide banners at the top of every role's shell, the mobile twin of the web portal's
/// banner strip. Maintenance banners stay until their window closes; the others can be dismissed.
class PlatformBannerStrip extends ConsumerWidget {
  const PlatformBannerStrip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final banners =
        ref.watch(platformBannersProvider).value ?? const <PlatformBanner>[];
    final dismissed = ref.watch(dismissedPlatformBannersProvider);
    final visible = banners
        .where(
          (banner) => !banner.dismissible || !dismissed.contains(banner.id),
        )
        .toList();
    if (visible.isEmpty) return const SizedBox.shrink();

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final banner in visible) _PlatformBannerTile(banner: banner),
      ],
    );
  }
}

class _PlatformBannerTile extends ConsumerWidget {
  const _PlatformBannerTile({required this.banner});

  final PlatformBanner banner;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final semantic = theme.extension<AppSemanticColors>()!;
    final (
      Color background,
      Color foreground,
      IconData icon,
      String labelKey,
    ) = switch (banner.severity) {
      PlatformAnnouncementSeverity.maintenance => (
        theme.colorScheme.errorContainer,
        theme.colorScheme.onErrorContainer,
        Icons.build_circle_outlined,
        'shell.platformBanner.maintenance',
      ),
      PlatformAnnouncementSeverity.warning => (
        semantic.warningContainer,
        semantic.onWarningContainer,
        Icons.warning_amber_outlined,
        'shell.platformBanner.warning',
      ),
      _ => (
        theme.colorScheme.secondaryContainer,
        theme.colorScheme.onSecondaryContainer,
        Icons.campaign_outlined,
        'shell.platformBanner.info',
      ),
    };
    final arabic = context.locale.languageCode == 'ar';
    final message = arabic && banner.messageAr != null
        ? banner.messageAr!
        : banner.messageEn;

    return Semantics(
      liveRegion: true,
      container: true,
      child: ColoredBox(
        color: background,
        child: Padding(
          padding: const EdgeInsetsDirectional.only(
            start: AppSpacing.space16,
            end: AppSpacing.space8,
            top: AppSpacing.space12,
            bottom: AppSpacing.space12,
          ),
          child: Row(
            children: [
              Icon(icon, size: 20, color: foreground),
              const SizedBox(width: AppSpacing.space8),
              Expanded(
                child: Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: '${labelKey.tr()} ',
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      ),
                      TextSpan(text: message),
                    ],
                  ),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: foreground,
                  ),
                ),
              ),
              if (banner.dismissible)
                IconButton(
                  tooltip: 'shell.platformBanner.dismiss'.tr(),
                  icon: Icon(Icons.close, color: foreground),
                  onPressed: () => ref
                      .read(dismissedPlatformBannersProvider.notifier)
                      .dismiss(banner.id),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
