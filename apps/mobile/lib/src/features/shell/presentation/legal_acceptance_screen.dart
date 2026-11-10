import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/api/generated/models/legal_acceptance_status.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/shell_providers.dart';

/// Shown instead of the shell until the signed-in user accepts the current Terms of Service and
/// confirms they have read the Privacy Policy (`AccountProfile.legalAcceptance`, migration
/// 000187). The server refuses such a session everything but accepting, deleting the account and
/// signing out, so those are the actions here. A first sign-in and a later change to either
/// document both land here; a previous acceptance picks the "updated" wording.
///
/// Accepting goes through [acceptLegalDocumentsProvider], which renews the token and reloads the
/// profile; with nothing left to accept, [AppShell] shows the shell. Mirrors the web app's
/// `LegalAcceptanceScreen`.
class LegalAcceptanceScreen extends ConsumerStatefulWidget {
  const LegalAcceptanceScreen({required this.versions, super.key});

  final LegalAcceptanceStatus versions;

  @override
  ConsumerState<LegalAcceptanceScreen> createState() =>
      _LegalAcceptanceScreenState();
}

class _LegalAcceptanceScreenState extends ConsumerState<LegalAcceptanceScreen> {
  bool _accepted = false;
  bool _saving = false;
  String? _error;

  Future<void> _accept() async {
    final accept = ref.read(acceptLegalDocumentsProvider);
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await accept(widget.versions);
    } catch (error) {
      if (!mounted) return;
      final outdated =
          error is DioException && error.response?.statusCode == 409;
      setState(() {
        _saving = false;
        _error = outdated
            ? 'shell.profile.legalAcceptance.outdated'.tr()
            : 'shell.profile.legalAcceptance.failed'.tr();
      });
    }
  }

  void _open(Uri url) {
    launchUrl(url, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final isUpdate = widget.versions.acceptedAt != null;

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
                    Icons.gavel_outlined,
                    size: 56,
                    color: colorScheme.primary,
                  ),
                  const SizedBox(height: AppSpacing.space16),
                  Text(
                    (isUpdate
                            ? 'shell.profile.legalAcceptance.updatedTitle'
                            : 'shell.profile.legalAcceptance.title')
                        .tr(),
                    key: const Key('legalAcceptanceTitle'),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.headlineSmall?.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space12),
                  Text(
                    (isUpdate
                            ? 'shell.profile.legalAcceptance.updatedBody'
                            : 'shell.profile.legalAcceptance.body')
                        .tr(),
                    textAlign: TextAlign.center,
                    style: theme.textTheme.bodyLarge,
                  ),
                  const SizedBox(height: AppSpacing.space16),
                  OutlinedButton.icon(
                    key: const Key('legalAcceptanceTerms'),
                    onPressed: () => _open(ref.read(termsUrlProvider)),
                    icon: const Icon(Icons.open_in_new),
                    label: Text('shell.profile.legalAcceptance.terms'.tr()),
                  ),
                  const SizedBox(height: AppSpacing.space8),
                  OutlinedButton.icon(
                    key: const Key('legalAcceptancePrivacy'),
                    onPressed: () => _open(ref.read(privacyPolicyUrlProvider)),
                    icon: const Icon(Icons.open_in_new),
                    label: Text('shell.profile.legalAcceptance.privacy'.tr()),
                  ),
                  const SizedBox(height: AppSpacing.space16),
                  CheckboxListTile(
                    key: const Key('legalAcceptanceCheckbox'),
                    value: _accepted,
                    onChanged: _saving
                        ? null
                        : (value) => setState(() => _accepted = value ?? false),
                    controlAffinity: ListTileControlAffinity.leading,
                    contentPadding: EdgeInsets.zero,
                    title: Text('shell.profile.legalAcceptance.checkbox'.tr()),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: AppSpacing.space12),
                    Text(
                      _error!,
                      key: const Key('legalAcceptanceError'),
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: colorScheme.error,
                      ),
                    ),
                  ],
                  const SizedBox(height: AppSpacing.space24),
                  FilledButton(
                    key: const Key('legalAcceptanceAccept'),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                      shape: const RoundedRectangleBorder(
                        borderRadius: AppRadius.mdRadius,
                      ),
                    ),
                    onPressed: _accepted && !_saving ? _accept : null,
                    child: _saving
                        ? SizedBox.square(
                            dimension: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: colorScheme.onPrimary,
                              semanticsLabel:
                                  'shell.profile.legalAcceptance.accepting'
                                      .tr(),
                            ),
                          )
                        : Text('shell.profile.legalAcceptance.accept'.tr()),
                  ),
                  const SizedBox(height: AppSpacing.space12),
                  OutlinedButton(
                    key: const Key('legalAcceptanceSignOut'),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                    ),
                    onPressed: _saving
                        ? null
                        : () =>
                              ref.read(authNotifierProvider.notifier).logout(),
                    child: Text('shell.profile.legalAcceptance.signOut'.tr()),
                  ),
                  const SizedBox(height: AppSpacing.space8),
                  TextButton(
                    key: const Key('legalAcceptanceDelete'),
                    onPressed: _saving
                        ? null
                        : () => _open(ref.read(publicAccountDeleteUrlProvider)),
                    child: Text('shell.profile.legalAcceptance.delete'.tr()),
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
