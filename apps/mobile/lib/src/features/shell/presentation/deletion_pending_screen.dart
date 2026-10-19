import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_providers.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/shell_providers.dart';

/// Shown instead of the shell when the signed-in account has a deletion scheduled (its 14-day
/// grace period, `AccountProfile.deletionScheduledFor`). The server confines such a session to
/// cancelling or signing out, so those are the only two actions here.
///
/// Cancelling (`DELETE /api/account/deletion`) renews the token and reloads the profile through
/// [cancelAccountDeletionProvider]; with no deletion scheduled, [AppShell] shows the shell again.
class DeletionPendingScreen extends ConsumerStatefulWidget {
  const DeletionPendingScreen({required this.scheduledFor, super.key});

  final DateTime scheduledFor;

  @override
  ConsumerState<DeletionPendingScreen> createState() =>
      _DeletionPendingScreenState();
}

class _DeletionPendingScreenState extends ConsumerState<DeletionPendingScreen> {
  bool _cancelling = false;
  String? _error;

  Future<void> _cancel() async {
    final cancel = ref.read(cancelAccountDeletionProvider);
    setState(() {
      _cancelling = true;
      _error = null;
    });
    try {
      await cancel();
    } catch (_) {
      if (mounted) {
        setState(() {
          _cancelling = false;
          _error = 'shell.profile.deletionPending.failed'.tr();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final date = DateFormat.yMMMMd(
      context.locale.toLanguageTag(),
    ).format(widget.scheduledFor.toLocal());

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(AppSpacing.space24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(
                    Icons.schedule_outlined,
                    size: 56,
                    color: colorScheme.error,
                  ),
                  const SizedBox(height: AppSpacing.space16),
                  Text(
                    'shell.profile.deletionPending.title'.tr(),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space12),
                  Text(
                    'shell.profile.deletionPending.body'.tr(
                      namedArgs: {'date': date},
                    ),
                    key: const Key('deletionPendingBody'),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyLarge,
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: AppSpacing.space12),
                    Text(
                      _error!,
                      key: const Key('deletionPendingError'),
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: colorScheme.error,
                      ),
                    ),
                  ],
                  const SizedBox(height: AppSpacing.space24),
                  FilledButton.icon(
                    key: const Key('deletionPendingCancel'),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                      shape: const RoundedRectangleBorder(
                        borderRadius: AppRadius.mdRadius,
                      ),
                    ),
                    onPressed: _cancelling ? null : _cancel,
                    icon: _cancelling
                        ? SizedBox.square(
                            dimension: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: colorScheme.onPrimary,
                              semanticsLabel:
                                  'shell.profile.deletionPending.cancelling'
                                      .tr(),
                            ),
                          )
                        : const Icon(Icons.restore),
                    label: Text('shell.profile.deletionPending.cancel'.tr()),
                  ),
                  const SizedBox(height: AppSpacing.space12),
                  OutlinedButton(
                    key: const Key('deletionPendingSignOut'),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                    ),
                    onPressed: _cancelling
                        ? null
                        : () =>
                              ref.read(authNotifierProvider.notifier).logout(),
                    child: Text('shell.profile.deletionPending.signOut'.tr()),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
