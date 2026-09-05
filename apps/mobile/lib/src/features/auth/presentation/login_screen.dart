import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_notifier.dart';
import '../../../core/auth/auth_state.dart';
import '../../../core/config/app_environment.dart';
import '../../../core/di/app_providers.dart';

class LoginScreen extends ConsumerWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(authNotifierProvider);
    // Dev-flavor only (ST-247) — same posture as the web app's "Continue with Mock" button
    // (VITE_ENABLE_MOCK_AUTH): the mock provider 404s outside dev/test regardless, this just keeps
    // the affordance itself out of the staging/prod app bundles. Lets the Flutter integration_test
    // suite drive the real login screen instead of reaching around it.
    final showMockLogin = ref.watch(appConfigProvider).environment == AppEnvironment.dev;

    ref.listen<AuthStatus>(authNotifierProvider, (prev, next) {
      if (next == AuthStatus.unauthenticated && prev == AuthStatus.loading) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Sign-in was cancelled or failed.')),
        );
      }
    });

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: status == AuthStatus.loading
              ? const CircularProgressIndicator()
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      'Studafy',
                      style: Theme.of(context).textTheme.headlineMedium,
                    ),
                    const SizedBox(height: 48),
                    FilledButton.icon(
                      onPressed: () =>
                          ref.read(authNotifierProvider.notifier).login('microsoft'),
                      icon: const Icon(Icons.login),
                      label: const Text('Sign in with Microsoft'),
                    ),
                    const SizedBox(height: 12),
                    OutlinedButton.icon(
                      onPressed: () =>
                          ref.read(authNotifierProvider.notifier).login('google'),
                      icon: const Icon(Icons.login),
                      label: const Text('Sign in with Google'),
                    ),
                    if (showMockLogin) ...[
                      const SizedBox(height: 12),
                      TextButton(
                        key: const Key('mockLoginButton'),
                        onPressed: () => ref
                            .read(authNotifierProvider.notifier)
                            .login('mock', loginHint: ref.read(mockLoginHintProvider)),
                        child: const Text('Continue with Mock'),
                      ),
                    ],
                  ],
                ),
        ),
      ),
    );
  }
}
