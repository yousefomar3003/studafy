import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../design/tokens/app_spacing_tokens.dart';
import 'store_listing.dart';
import 'update_providers.dart';

/// The blocking screen shown while `updateStatusProvider` is `updateRequired`. `forcedUpdateGuard`
/// redirects here from every route and holds the app here — there is nothing to navigate to and
/// no back gesture out (`PopScope(canPop: false)`), because the running build is below the floor
/// the backend still serves.
class ForcedUpdateScreen extends ConsumerStatefulWidget {
  const ForcedUpdateScreen({super.key});

  @override
  ConsumerState<ForcedUpdateScreen> createState() => _ForcedUpdateScreenState();
}

class _ForcedUpdateScreenState extends ConsumerState<ForcedUpdateScreen> {
  bool _failed = false;

  Future<void> _openStore() async {
    final platform = ref.read(currentMobilePlatformProvider);
    final launched = await launchUrl(
      storeListingUri(platform),
      mode: LaunchMode.externalApplication,
    );
    if (mounted) setState(() => _failed = !launched);
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return PopScope(
      canPop: false,
      child: Scaffold(
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.space24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.system_update,
                    size: 64,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                  const SizedBox(height: AppSpacing.space24),
                  Text(
                    'update.required.title'.tr(),
                    style: textTheme.headlineSmall,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: AppSpacing.space16),
                  Text(
                    'update.required.body'.tr(),
                    style: textTheme.bodyMedium,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: AppSpacing.space24),
                  FilledButton(
                    onPressed: _openStore,
                    child: Text('update.required.action'.tr()),
                  ),
                  if (_failed) ...[
                    const SizedBox(height: AppSpacing.space16),
                    Text(
                      'update.required.error'.tr(),
                      style: textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.error,
                      ),
                      textAlign: TextAlign.center,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
