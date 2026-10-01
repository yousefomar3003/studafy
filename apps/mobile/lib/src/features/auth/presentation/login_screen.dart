import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/auth_notifier.dart';
import '../../../core/auth/auth_state.dart';
import '../../../core/config/app_environment.dart';
import '../../../core/di/app_providers.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  bool _showEmailForm = false;

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(authNotifierProvider);
    // Dev-flavor only (ST-247) — same posture as the web app's "Continue with Mock" button
    // (VITE_ENABLE_MOCK_AUTH): the mock provider 404s outside dev/test regardless, this just keeps
    // the affordance itself out of the staging/prod app bundles. Lets the Flutter integration_test
    // suite drive the real login screen instead of reaching around it.
    final showMockLogin =
        ref.watch(appConfigProvider).environment == AppEnvironment.dev;

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
              ? const CircularProgressIndicator(semanticsLabel: 'Signing in')
              : SingleChildScrollView(
                  padding: const EdgeInsets.all(24),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 360),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          'Studafy',
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.headlineMedium,
                        ),
                        const SizedBox(height: 48),
                        FilledButton.icon(
                          onPressed: () => ref
                              .read(authNotifierProvider.notifier)
                              .login('microsoft'),
                          icon: const Icon(Icons.login),
                          label: const Text('Sign in with Microsoft'),
                        ),
                        const SizedBox(height: 12),
                        OutlinedButton.icon(
                          onPressed: () => ref
                              .read(authNotifierProvider.notifier)
                              .login('google'),
                          icon: const Icon(Icons.login),
                          label: const Text('Sign in with Google'),
                        ),
                        const SizedBox(height: 12),
                        if (_showEmailForm)
                          const _EmailSignInForm()
                        else
                          TextButton(
                            key: const Key('emailSignInToggle'),
                            onPressed: () =>
                                setState(() => _showEmailForm = true),
                            child: const Text('Sign in with email'),
                          ),
                        if (showMockLogin) ...[
                          const SizedBox(height: 12),
                          TextButton(
                            key: const Key('mockLoginButton'),
                            onPressed: () => ref
                                .read(authNotifierProvider.notifier)
                                .login(
                                  'mock',
                                  loginHint: ref.read(mockLoginHintProvider),
                                ),
                            child: const Text('Continue with Mock'),
                          ),
                        ],
                        const SizedBox(height: 24),
                        TextButton(
                          onPressed: () => launchUrl(
                            ref.read(privacyPolicyUrlProvider),
                            mode: LaunchMode.externalApplication,
                          ),
                          child: const Text('Privacy policy'),
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

/// Email/password sign-in (ST-303). The API accepts only the App Store / Play reviewer demo
/// accounts on this path — see `review-login-routes.ts` and docs/runbooks/app-review-access.md.
class _EmailSignInForm extends ConsumerStatefulWidget {
  const _EmailSignInForm();

  @override
  ConsumerState<_EmailSignInForm> createState() => _EmailSignInFormState();
}

class _EmailSignInFormState extends ConsumerState<_EmailSignInForm> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting || !_formKey.currentState!.validate()) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref
          .read(authNotifierProvider.notifier)
          .loginWithEmail(email: _email.text.trim(), password: _password.text);
      // On success the auth guard navigates away; nothing else to do here.
    } catch (error) {
      if (mounted) setState(() => _error = _messageFor(error));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  static String _messageFor(Object error) {
    final apiError = error is DioException ? error.apiError : null;
    if (apiError?.code == 'AUTH_INVALID_CREDENTIALS') {
      return 'Incorrect email or password.';
    }
    if (apiError?.status == 429) {
      return 'Too many attempts. Wait a minute and try again.';
    }
    return "Couldn't sign in. Check your connection and try again.";
  }

  @override
  Widget build(BuildContext context) {
    return AutofillGroup(
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextFormField(
              key: const Key('emailSignInEmail'),
              controller: _email,
              enabled: !_submitting,
              keyboardType: TextInputType.emailAddress,
              autocorrect: false,
              autofillHints: const [AutofillHints.email],
              textInputAction: TextInputAction.next,
              decoration: const InputDecoration(labelText: 'Email'),
              validator: (value) => (value ?? '').trim().contains('@')
                  ? null
                  : 'Enter your email address.',
            ),
            const SizedBox(height: 12),
            TextFormField(
              key: const Key('emailSignInPassword'),
              controller: _password,
              enabled: !_submitting,
              obscureText: true,
              autofillHints: const [AutofillHints.password],
              textInputAction: TextInputAction.done,
              onFieldSubmitted: (_) => _submit(),
              decoration: const InputDecoration(labelText: 'Password'),
              validator: (value) =>
                  (value ?? '').isEmpty ? 'Enter your password.' : null,
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                key: const Key('emailSignInError'),
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
            const SizedBox(height: 16),
            FilledButton(
              key: const Key('emailSignInSubmit'),
              onPressed: _submitting ? null : _submit,
              child: _submitting
                  ? const SizedBox.square(
                      dimension: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        semanticsLabel: 'Signing in',
                      ),
                    )
                  : const Text('Sign in'),
            ),
          ],
        ),
      ),
    );
  }
}
