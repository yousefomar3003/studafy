import 'dart:async';

import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/auth_notifier.dart';
import '../../../core/auth/auth_state.dart';
import '../../../core/auth/oauth_browser.dart';
import '../../../core/auth/saved_account.dart';
import '../../../core/auth/school_closed_notice.dart';
import '../../../core/di/app_providers.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/widgets/studafy_logo.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../shell/presentation/account_switcher.dart';
import '../../shell/presentation/locale_toggle_button.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

/// Seeded demo personas (db/seeds/mock-credentials.ts) offered by "Continue with Mock" when no
/// [mockLoginHintProvider] override names one. Without a `login_hint` the mock IdP signs in as its
/// own fallback subject, which no seed creates, so the API answers "No account found".
const _mockPersonas = [
  (
    key: 'mockPersonaStudent',
    roleKey: 'auth.login.roles.student',
    name: 'Adam Fares',
    email: 'adam.fares@demo.studafy.test',
  ),
  (
    key: 'mockPersonaTeacher',
    roleKey: 'auth.login.roles.teacher',
    name: 'Layla Nasser',
    email: 'layla.nasser@demo.studafy.test',
  ),
  (
    key: 'mockPersonaParent',
    roleKey: 'auth.login.roles.parent',
    name: 'Fares family',
    email: 'fares.parent@demo.studafy.test',
  ),
  (
    key: 'mockPersonaAttendanceOfficer',
    roleKey: 'auth.login.roles.attendanceOfficer',
    name: 'Hala Mansour',
    email: 'attendance@demo.studafy.test',
  ),
];

class _LoginScreenState extends ConsumerState<LoginScreen> {
  late final AppLifecycleListener _lifecycle;
  Timer? _abandonedSignInTimer;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onResume: _onResume);
  }

  @override
  void dispose() {
    _abandonedSignInTimer?.cancel();
    _lifecycle.dispose();
    super.dispose();
  }

  /// Closing the sign-in browser on Android sends the app no callback, so a browser sign-in would
  /// wait forever. Back in the app with sign-in still pending, give a late redirect a moment to
  /// land, then abandon it — the screen returns to the form with the "failed" snackbar. A no-op
  /// once the callback has arrived (the token exchange is no longer cancellable).
  ///
  /// Not on iOS: the `ASWebAuthenticationSession` sheet itself sends the app through inactive and
  /// back to resumed while it is still open, so this would cancel a sign-in in progress. The
  /// session reports its own dismissal there.
  void _onResume() {
    if (OAuthBrowser.usesWebAuthSession) return;
    _abandonedSignInTimer?.cancel();
    _abandonedSignInTimer = Timer(const Duration(seconds: 2), () {
      if (mounted && ref.read(authNotifierProvider) == AuthStatus.loading) {
        ref.read(authNotifierProvider.notifier).cancelLogin();
      }
    });
  }

  /// Signs in through the mock IdP. The integration_test suite overrides [mockLoginHintProvider]
  /// to target a persona directly; otherwise the developer picks one of [_mockPersonas].
  Future<void> _continueWithMock() async {
    final auth = ref.read(authNotifierProvider.notifier);
    final hint = ref.read(mockLoginHintProvider);
    if (hint != null) {
      await auth.login('mock', loginHint: hint);
      return;
    }

    final email = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsetsDirectional.fromSTEB(
                AppSpacing.space24,
                AppSpacing.space16,
                AppSpacing.space24,
                AppSpacing.space8,
              ),
              child: Text(
                'auth.login.mockSheetTitle'.tr(),
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            for (final persona in _mockPersonas)
              ListTile(
                key: Key(persona.key),
                title: Text(persona.roleKey.tr()),
                subtitle: Text('${persona.name} · ${persona.email}'),
                onTap: () => Navigator.of(context).pop(persona.email),
              ),
          ],
        ),
      ),
    );
    if (email != null && mounted) {
      await auth.login('mock', loginHint: email);
    }
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(authNotifierProvider);
    // Opt-in only, via SHOW_DEMO_LOGIN (a --dart-define) — never on by flavor, so dev builds sign
    // in with a real member ID and password like every other build. The Flutter integration_test
    // suite sets it to drive the real login screen instead of reaching around it (ST-247). It is
    // never set by the release lanes, and a production API rejects the mock provider anyway.
    const showMockLogin = bool.fromEnvironment('SHOW_DEMO_LOGIN');

    ref.listen<AuthStatus>(authNotifierProvider, (prev, next) {
      // A closed school already has its own, persistent explanation on this screen.
      if (next == AuthStatus.unauthenticated &&
          prev == AuthStatus.loading &&
          !ref.read(schoolClosedNoticeProvider)) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('auth.login.failed'.tr())));
      }
    });

    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            // Language switch, top-end (top-left in RTL). Offered before sign-in so a user can
            // read the whole flow in their language; the choice persists across launches.
            const Padding(
              padding: EdgeInsets.symmetric(
                horizontal: AppSpacing.space8,
                vertical: AppSpacing.space4,
              ),
              child: Align(
                alignment: AlignmentDirectional.centerEnd,
                child: LocaleToggleButton(),
              ),
            ),
            Expanded(
              child: Center(
                child: status == AuthStatus.loading
                    ? const _SigningIn()
                    : SingleChildScrollView(
                        padding: const EdgeInsets.symmetric(
                          horizontal: AppSpacing.space24,
                          vertical: AppSpacing.space16,
                        ),
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 400),
                          child: _signInOptions(context, showMockLogin),
                        ),
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _signInOptions(BuildContext context, bool showMockLogin) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final schoolClosed = ref.watch(schoolClosedNoticeProvider);
    final savedAccounts = ref.watch(savedAccountsProvider);

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Center(child: StudafyLogo(key: Key('brandLogo'), height: 48)),
        const SizedBox(height: AppSpacing.space16),
        Text(
          'auth.login.subtitle'.tr(),
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: colorScheme.onSurfaceVariant,
          ),
        ),
        if (schoolClosed) ...[
          const SizedBox(height: AppSpacing.space24),
          const _SchoolClosedNotice(),
        ],
        if (savedAccounts.isNotEmpty) ...[
          const SizedBox(height: AppSpacing.space24),
          _SavedAccounts(accounts: savedAccounts),
          const SizedBox(height: AppSpacing.space24),
          Text(
            'auth.login.savedAccounts.orSignIn'.tr(),
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
        ],
        const SizedBox(height: AppSpacing.space32),
        Card(
          margin: EdgeInsets.zero,
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.space24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Students, parents, teachers and attendance officers: their school-issued ID and
                // a password. The only way to sign in on mobile.
                const _MemberSignInForm(),
              ],
            ),
          ),
        ),
        // Opt-in builds only — see `showMockLogin` above.
        if (showMockLogin) ...[
          const SizedBox(height: AppSpacing.space12),
          TextButton.icon(
            key: const Key('mockLoginButton'),
            onPressed: _continueWithMock,
            icon: const Icon(Icons.science_outlined),
            label: Text('auth.login.mock'.tr()),
          ),
        ],
        const SizedBox(height: AppSpacing.space24),
        Center(
          child: TextButton(
            onPressed: () => launchUrl(
              ref.read(privacyPolicyUrlProvider),
              mode: LaunchMode.externalApplication,
            ),
            style: TextButton.styleFrom(
              foregroundColor: colorScheme.onSurfaceVariant,
            ),
            child: Text('auth.login.privacyPolicy'.tr()),
          ),
        ),
      ],
    );
  }
}

/// The other accounts still signed in on this phone ("Add account", or after logging out of one):
/// one tap opens each, no password needed, and each can be removed from the phone.
class _SavedAccounts extends ConsumerWidget {
  const _SavedAccounts({required this.accounts});

  final List<SavedAccount> accounts;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final auth = ref.read(authNotifierProvider.notifier);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'auth.login.savedAccounts.title'.tr(),
          style: theme.textTheme.titleSmall,
        ),
        const SizedBox(height: AppSpacing.space8),
        Card(
          margin: EdgeInsets.zero,
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              for (final account in accounts)
                AccountTile(
                  key: Key('savedAccount-${account.userId}'),
                  label: account.label,
                  roles: account.roles,
                  onTap: () => auth.switchTo(account.userId),
                  trailing: IconButton(
                    key: Key('savedAccountRemove-${account.userId}'),
                    icon: const Icon(Icons.close),
                    tooltip: 'auth.login.savedAccounts.remove'.tr(
                      namedArgs: {
                        'name': accountName(account.label, account.roles),
                      },
                    ),
                    onPressed: () => auth.removeSavedAccount(account.userId),
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

/// Why the user was signed out: their school was closed. Stays until a sign-in succeeds (see
/// [schoolClosedNoticeProvider]) rather than flashing past as a snackbar.
class _SchoolClosedNotice extends StatelessWidget {
  const _SchoolClosedNotice();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Semantics(
      liveRegion: true,
      child: Card(
        key: const Key('schoolClosedNotice'),
        margin: EdgeInsets.zero,
        color: colorScheme.errorContainer,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space16),
          child: Row(
            children: [
              Icon(
                Icons.domain_disabled_outlined,
                color: colorScheme.onErrorContainer,
              ),
              const SizedBox(width: AppSpacing.space12),
              Expanded(
                child: Text(
                  'auth.login.schoolClosed'.tr(),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colorScheme.onErrorContainer,
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

/// Shown while the OAuth browser flow is in progress.
/// The sign-in-in-progress state: the brand logo over a lock badge circled by a spinning ring,
/// with a short reassurance line. No cancel action — an abandoned browser sign-in ends itself
/// when the user comes back to the app (see [_LoginScreenState._onResume]).
class _SigningIn extends StatelessWidget {
  const _SigningIn();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    // A translucent tint of the brand blue, so the track and badge show on either theme's surface.
    final tint = colorScheme.primary.withValues(alpha: 0.14);

    return Semantics(
      liveRegion: true,
      label: 'auth.login.signingIn'.tr(),
      child: ExcludeSemantics(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const StudafyLogo(height: 40),
              const SizedBox(height: AppSpacing.space40),
              SizedBox.square(
                dimension: 96,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    // Static track under the spinning arc.
                    SizedBox.expand(
                      child: CircularProgressIndicator(
                        value: 1,
                        strokeWidth: 4,
                        color: tint,
                      ),
                    ),
                    SizedBox.expand(
                      child: CircularProgressIndicator(
                        key: const Key('signingInProgress'),
                        strokeWidth: 4,
                        strokeCap: StrokeCap.round,
                        color: colorScheme.primary,
                      ),
                    ),
                    DecoratedBox(
                      decoration: BoxDecoration(
                        color: tint,
                        borderRadius: AppRadius.fullRadius,
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(AppSpacing.space16),
                        child: Icon(
                          Icons.lock_outline_rounded,
                          size: 28,
                          color: colorScheme.primary,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AppSpacing.space24),
              Text(
                'auth.login.signingIn'.tr(),
                textAlign: TextAlign.center,
                style: theme.textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: AppSpacing.space8),
              Text(
                'auth.login.signingInHint'.tr(),
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Member-ID + password sign-in (`member-password-routes.ts`). Two steps: ID and password, then —
/// only while the account is still on the starting password the school handed out — choosing a new
/// password, which the API requires before it issues a session.
class _MemberSignInForm extends ConsumerStatefulWidget {
  const _MemberSignInForm();

  @override
  ConsumerState<_MemberSignInForm> createState() => _MemberSignInFormState();
}

class _MemberSignInFormState extends ConsumerState<_MemberSignInForm> {
  static const _minLength = 8;

  final _formKey = GlobalKey<FormState>();
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _newPassword = TextEditingController();
  final _confirmPassword = TextEditingController();
  bool _choosingNewPassword = false;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    _newPassword.dispose();
    _confirmPassword.dispose();
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
          .loginWithMember(
            username: _username.text.trim(),
            password: _password.text,
            newPassword: _choosingNewPassword ? _newPassword.text : null,
          );
      // On success the auth guard navigates away.
    } catch (error) {
      final apiError = error is DioException ? error.apiError : null;
      if (apiError?.code == 'AUTH_PASSWORD_CHANGE_REQUIRED') {
        if (mounted) setState(() => _choosingNewPassword = true);
      } else if (mounted) {
        setState(() => _error = _messageFor(error));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  void _back() => setState(() {
    _choosingNewPassword = false;
    _newPassword.clear();
    _confirmPassword.clear();
    _error = null;
  });

  static String _messageFor(Object error) {
    final apiError = error is DioException ? error.apiError : null;
    switch (apiError?.code) {
      case 'AUTH_INVALID_CREDENTIALS':
        return 'auth.memberForm.invalidCredentials'.tr();
      case 'AUTH_ACCOUNT_LOCKED':
        return 'auth.memberForm.locked'.tr();
      case 'AUTH_PASSWORD_REJECTED':
        return apiError?.detail ?? 'auth.memberForm.passwordRejected'.tr();
      case schoolClosedErrorCode:
        return 'auth.login.schoolClosed'.tr();
    }
    if (apiError?.status == 429) return 'auth.emailForm.rateLimited'.tr();
    return 'auth.emailForm.genericError'.tr();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AutofillGroup(
      child: Form(
        key: _formKey,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (!_choosingNewPassword) ...[
              TextFormField(
                key: const Key('memberSignInUsername'),
                controller: _username,
                enabled: !_submitting,
                autocorrect: false,
                textCapitalization: TextCapitalization.characters,
                autofillHints: const [AutofillHints.username],
                textInputAction: TextInputAction.next,
                decoration: InputDecoration(
                  labelText: 'auth.memberForm.username'.tr(),
                  hintText: 'auth.memberForm.usernameHint'.tr(),
                ),
                validator: (value) => (value ?? '').trim().isEmpty
                    ? 'auth.memberForm.usernameRequired'.tr()
                    : null,
              ),
              const SizedBox(height: AppSpacing.space12),
              TextFormField(
                key: const Key('memberSignInPassword'),
                controller: _password,
                enabled: !_submitting,
                obscureText: true,
                autofillHints: const [AutofillHints.password],
                textInputAction: TextInputAction.done,
                onFieldSubmitted: (_) => _submit(),
                decoration: InputDecoration(
                  labelText: 'auth.emailForm.password'.tr(),
                ),
                validator: (value) => (value ?? '').isEmpty
                    ? 'auth.emailForm.passwordRequired'.tr()
                    : null,
              ),
            ] else ...[
              Text(
                'auth.memberForm.newPasswordTitle'.tr(),
                style: theme.textTheme.titleMedium,
              ),
              const SizedBox(height: AppSpacing.space8),
              Text(
                'auth.memberForm.newPasswordBody'.tr(),
                key: const Key('memberSignInChangeRequired'),
                style: theme.textTheme.bodyMedium,
              ),
              const SizedBox(height: AppSpacing.space12),
              TextFormField(
                key: const Key('memberSignInNewPassword'),
                controller: _newPassword,
                enabled: !_submitting,
                obscureText: true,
                autofillHints: const [AutofillHints.newPassword],
                textInputAction: TextInputAction.next,
                decoration: InputDecoration(
                  labelText: 'auth.memberForm.newPassword'.tr(),
                  helperText: 'auth.memberForm.newPasswordHelp'.tr(),
                ),
                validator: (value) => (value ?? '').length < _minLength
                    ? 'auth.memberForm.tooShort'.tr()
                    : null,
              ),
              const SizedBox(height: AppSpacing.space12),
              TextFormField(
                key: const Key('memberSignInConfirmPassword'),
                controller: _confirmPassword,
                enabled: !_submitting,
                obscureText: true,
                autofillHints: const [AutofillHints.newPassword],
                textInputAction: TextInputAction.done,
                onFieldSubmitted: (_) => _submit(),
                decoration: InputDecoration(
                  labelText: 'auth.memberForm.confirmPassword'.tr(),
                ),
                validator: (value) => value != _newPassword.text
                    ? 'auth.memberForm.mismatch'.tr()
                    : null,
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: AppSpacing.space12),
              Text(
                _error!,
                key: const Key('memberSignInError'),
                style: TextStyle(color: theme.colorScheme.error),
              ),
            ],
            const SizedBox(height: AppSpacing.space16),
            FilledButton(
              key: const Key('memberSignInSubmit'),
              style: FilledButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
              ),
              onPressed: _submitting ? null : _submit,
              child: _submitting
                  ? SizedBox.square(
                      dimension: 20,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        semanticsLabel: 'auth.login.signingIn'.tr(),
                      ),
                    )
                  : Text(
                      _choosingNewPassword
                          ? 'auth.memberForm.saveAndSignIn'.tr()
                          : 'auth.memberForm.submit'.tr(),
                    ),
            ),
            if (_choosingNewPassword)
              TextButton(
                key: const Key('memberSignInBack'),
                onPressed: _submitting ? null : _back,
                child: Text('auth.memberForm.back'.tr()),
              ),
          ],
        ),
      ),
    );
  }
}
