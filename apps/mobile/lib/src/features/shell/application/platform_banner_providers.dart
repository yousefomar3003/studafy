import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/platform_banner.dart';
import '../../../core/auth/auth_providers.dart';

/// Studafy-wide banners live for the signed-in user (`GET /api/platform-banners`): maintenance
/// windows and platform notices a Studafy super admin scheduled in the web console.
///
/// A banner is a nicety, never a blocker: any failure (offline, server error) yields no banners
/// rather than an error state in the shell.
final platformBannersProvider =
    FutureProvider.autoDispose<List<PlatformBanner>>((ref) async {
      try {
        final list = await ref
            .watch(apiClientProvider)
            .platform
            .listPlatformBanners();
        return list.banners;
      } catch (_) {
        return const [];
      }
    });

/// Banner ids the user dismissed this app session. Maintenance banners can't be dismissed, so
/// they never land here. Kept in memory only: a dismissed notice coming back after a restart is
/// harmless, and it keeps a server-side "dismissed" state out of the picture.
final dismissedPlatformBannersProvider =
    NotifierProvider<DismissedPlatformBanners, Set<String>>(
      DismissedPlatformBanners.new,
    );

class DismissedPlatformBanners extends Notifier<Set<String>> {
  @override
  Set<String> build() => const {};

  void dismiss(String id) => state = {...state, id};
}
