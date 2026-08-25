import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_notifier.dart';
import '../../../core/auth/auth_state.dart';

class LoginScreen extends ConsumerWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(authNotifierProvider);

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
                  ],
                ),
        ),
      ),
    );
  }
}
