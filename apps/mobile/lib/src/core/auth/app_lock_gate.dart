import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../design/tokens/app_spacing_tokens.dart';
import '../../design/widgets/studafy_logo.dart';
import 'app_lock.dart';
import 'auth_notifier.dart';
import 'auth_state.dart';

/// Covers the whole app while [appLockProvider] is locked and someone is signed in, and reports
/// the app going to and returning from the background so the lock can re-arm.
///
/// Sits in `MaterialApp.builder`, above the router: the screens underneath stay mounted, so
/// unlocking returns to exactly where the person was.
class AppLockGate extends ConsumerStatefulWidget {
  const AppLockGate({required this.child, super.key});

  final Widget child;

  @override
  ConsumerState<AppLockGate> createState() => _AppLockGateState();
}

class _AppLockGateState extends ConsumerState<AppLockGate>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState lifecycle) {
    final lock = ref.read(appLockProvider.notifier);
    switch (lifecycle) {
      case AppLifecycleState.paused:
        lock.onBackgrounded();
      case AppLifecycleState.resumed:
        lock.onForegrounded();
      default:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final lock = ref.watch(appLockProvider);
    final signedIn = ref.watch(authStatusProvider) == AuthStatus.authenticated;
    final covered = signedIn && (!lock.loaded || lock.locked);

    return Stack(
      children: [
        ExcludeSemantics(excluding: covered, child: widget.child),
        if (covered)
          Positioned.fill(
            child: lock.loaded
                ? const _LockScreen(key: Key('appLockScreen'))
                : ColoredBox(color: Theme.of(context).colorScheme.surface),
          ),
      ],
    );
  }
}

class _LockScreen extends ConsumerStatefulWidget {
  const _LockScreen({super.key});

  @override
  ConsumerState<_LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends ConsumerState<_LockScreen> {
  @override
  void initState() {
    super.initState();
    // Ask straight away, as other locked apps do; the button below is for a cancelled prompt.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _unlock();
    });
  }

  void _unlock() =>
      ref.read(appLockProvider.notifier).unlock('appLock.reason'.tr());

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;

    return Material(
      color: colors.surface,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space24),
          child: Column(
            children: [
              const Spacer(),
              const StudafyLogo(height: 40),
              const SizedBox(height: AppSpacing.space32),
              Icon(Icons.lock_outline, size: 40, color: colors.primary),
              const SizedBox(height: AppSpacing.space16),
              Text(
                'appLock.title'.tr(),
                style: theme.textTheme.titleLarge,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.space8),
              Text(
                'appLock.body'.tr(),
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
                textAlign: TextAlign.center,
              ),
              const Spacer(),
              FilledButton.icon(
                key: const Key('appLockUnlock'),
                onPressed: _unlock,
                icon: const Icon(Icons.face_outlined),
                label: Text('appLock.unlock'.tr()),
              ),
              const SizedBox(height: AppSpacing.space8),
              // A way out when the face or fingerprint is no longer recognised: signing in again
              // with the member ID and password is the fallback, as on any other device.
              TextButton(
                key: const Key('appLockSignOut'),
                onPressed: () =>
                    ref.read(authNotifierProvider.notifier).logout(),
                child: Text('appLock.signOut'.tr()),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
