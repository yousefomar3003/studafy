import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/generated/models/active_store_subscription.dart';
import '../../../core/api/generated/models/active_store_subscription_platform.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../design/theme/app_semantic_colors.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/shell_providers.dart';

/// "Delete my account": any signed-in user schedules deletion of their own account
/// (`POST /api/account/deletion`), as App Store Guideline 5.1.1(v) and Google Play's
/// account-deletion policy require in-app.
///
/// Deliberately hard to do by accident. The button enables only once the person has ticked the
/// acknowledgement, typed the confirmation word and — for accounts that sign in with a member ID
/// and password — entered both (the server checks them). A final dialog follows.
///
/// The deletion runs 14 days later; until then, signing in again offers to cancel it
/// ([DeletionPendingScreen]). The server signs out every session, so on success this screen shows
/// the date and clears the device's session through [AuthNotifier.handleAccountDeleted]; the
/// router's auth guard lands on login, replacing this screen.
///
/// An AI subscription bought in the App Store or Google Play — the person's own, or a linked
/// child's — keeps billing after the deletion: Apple offers no way to cancel it, Google Play only
/// a best-effort one when the account is finally deleted, and a parent's deletion cancels nothing
/// for their children. The profile's `active_store_subscriptions` adds
/// [StoreSubscriptionWarningCard], with the store's own cancel steps, above the form.
class DeleteAccountScreen extends ConsumerStatefulWidget {
  const DeleteAccountScreen({super.key});

  @override
  ConsumerState<DeleteAccountScreen> createState() =>
      _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends ConsumerState<DeleteAccountScreen> {
  final _memberIdController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmationController = TextEditingController();
  bool _acknowledged = false;
  bool _submitting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    for (final controller in [
      _memberIdController,
      _passwordController,
      _confirmationController,
    ]) {
      controller.addListener(() => setState(() {}));
    }
  }

  @override
  void dispose() {
    _memberIdController.dispose();
    _passwordController.dispose();
    _confirmationController.dispose();
    super.dispose();
  }

  bool _canSubmit(bool requiresCredentials) {
    final typed = _confirmationController.text.trim();
    final word = 'shell.profile.deleteAccount.typeWord'.tr();
    return !_submitting &&
        _acknowledged &&
        typed.toUpperCase() == word.toUpperCase() &&
        (!requiresCredentials ||
            (_memberIdController.text.trim().isNotEmpty &&
                _passwordController.text.isNotEmpty));
  }

  Future<void> _delete(bool requiresCredentials) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => const _ConfirmDialog(),
    );
    if (!(confirmed ?? false) || !mounted) return;

    final deleteAccount = ref.read(deleteOwnAccountProvider);
    final auth = ref.read(authNotifierProvider.notifier);

    setState(() {
      _submitting = true;
      _error = null;
    });
    final DateTime scheduledFor;
    try {
      scheduledFor = await deleteAccount(
        memberId: requiresCredentials ? _memberIdController.text.trim() : null,
        password: requiresCredentials ? _passwordController.text : null,
      );
    } catch (error) {
      if (mounted) {
        setState(() {
          _submitting = false;
          _error = _messageFor(error);
        });
      }
      return;
    }

    if (mounted) {
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (context) => _DoneDialog(scheduledFor: scheduledFor),
      );
    }
    await auth.handleAccountDeleted();
  }

  static String _messageFor(Object error) {
    final apiError = error is DioException ? error.apiError : null;
    return switch (apiError?.code) {
      'ACCOUNT_DELETION_VERIFICATION_FAILED' =>
        'shell.profile.deleteAccount.wrongCredentials'.tr(),
      'AUTH_ACCOUNT_LOCKED' => 'shell.profile.deleteAccount.locked'.tr(),
      'ACCOUNT_DELETION_ALREADY_SCHEDULED' || 'DSR_ALREADY_PENDING' =>
        'shell.profile.deleteAccount.alreadyPending'.tr(),
      _ => 'shell.profile.deleteAccount.failed'.tr(),
    };
  }

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(accountProfileProvider);

    return Scaffold(
      appBar: AppBar(title: Text('shell.profile.deleteAccount.title'.tr())),
      body: SafeArea(
        child: profile.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, _) =>
              _LoadError(onRetry: () => ref.invalidate(accountProfileProvider)),
          data: (profile) => _form(
            context,
            profile?.deletionRequiresMemberCredentials ?? false,
            profile?.activeStoreSubscriptions ?? const [],
          ),
        ),
      ),
    );
  }

  Widget _form(
    BuildContext context,
    bool requiresCredentials,
    List<ActiveStoreSubscription> storeSubscriptions,
  ) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final word = 'shell.profile.deleteAccount.typeWord'.tr();

    return SingleChildScrollView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _WarningCard(),
              if (storeSubscriptions.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.space16),
                StoreSubscriptionWarningCard(subscriptions: storeSubscriptions),
              ],
              if (requiresCredentials) ...[
                const SizedBox(height: AppSpacing.space24),
                Text(
                  'shell.profile.deleteAccount.credentialsPrompt'.tr(),
                  style: theme.textTheme.bodyMedium,
                ),
                const SizedBox(height: AppSpacing.space12),
                TextField(
                  key: const Key('deleteAccountMemberId'),
                  controller: _memberIdController,
                  enabled: !_submitting,
                  autocorrect: false,
                  enableSuggestions: false,
                  textCapitalization: TextCapitalization.characters,
                  autofillHints: const [AutofillHints.username],
                  decoration: InputDecoration(
                    labelText: 'shell.profile.deleteAccount.memberIdLabel'.tr(),
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: AppSpacing.space12),
                TextField(
                  key: const Key('deleteAccountPassword'),
                  controller: _passwordController,
                  enabled: !_submitting,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  autofillHints: const [AutofillHints.password],
                  decoration: InputDecoration(
                    labelText: 'shell.profile.deleteAccount.passwordLabel'.tr(),
                    border: const OutlineInputBorder(),
                  ),
                ),
              ],
              const SizedBox(height: AppSpacing.space16),
              CheckboxListTile(
                key: const Key('deleteAccountAcknowledge'),
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _acknowledged,
                onChanged: _submitting
                    ? null
                    : (value) => setState(() => _acknowledged = value ?? false),
                title: Text(
                  'shell.profile.deleteAccount.acknowledge'.tr(),
                  style: theme.textTheme.bodyMedium,
                ),
              ),
              const SizedBox(height: AppSpacing.space8),
              Text(
                'shell.profile.deleteAccount.typePrompt'.tr(
                  namedArgs: {'word': word},
                ),
                style: theme.textTheme.bodyMedium,
              ),
              const SizedBox(height: AppSpacing.space8),
              TextField(
                key: const Key('deleteAccountConfirmation'),
                controller: _confirmationController,
                enabled: !_submitting,
                autocorrect: false,
                enableSuggestions: false,
                textInputAction: TextInputAction.done,
                decoration: InputDecoration(
                  labelText: 'shell.profile.deleteAccount.typeLabel'.tr(),
                  hintText: word,
                  border: const OutlineInputBorder(),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: AppSpacing.space12),
                Text(
                  _error!,
                  key: const Key('deleteAccountError'),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colorScheme.error,
                  ),
                ),
              ],
              const SizedBox(height: AppSpacing.space24),
              FilledButton.icon(
                key: const Key('deleteAccountConfirm'),
                style: FilledButton.styleFrom(
                  backgroundColor: colorScheme.error,
                  foregroundColor: colorScheme.onError,
                  minimumSize: const Size.fromHeight(48),
                  shape: const RoundedRectangleBorder(
                    borderRadius: AppRadius.mdRadius,
                  ),
                ),
                onPressed: _canSubmit(requiresCredentials)
                    ? () => _delete(requiresCredentials)
                    : null,
                icon: _submitting
                    ? SizedBox.square(
                        dimension: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: colorScheme.onError,
                          semanticsLabel: 'shell.profile.deleteAccount.deleting'
                              .tr(),
                        ),
                      )
                    : const Icon(Icons.delete_forever_outlined),
                label: Text('shell.profile.deleteAccount.confirm'.tr()),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _WarningCard extends StatelessWidget {
  const _WarningCard();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final onContainer = colorScheme.onErrorContainer;

    return Card(
      margin: EdgeInsets.zero,
      color: colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.warning_amber_rounded, color: onContainer),
                const SizedBox(width: AppSpacing.space12),
                Expanded(
                  child: Text(
                    'shell.profile.deleteAccount.warningTitle'.tr(),
                    style: theme.textTheme.titleMedium?.copyWith(
                      color: onContainer,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            for (final key in const [
              'shell.profile.deleteAccount.consequences.signedOut',
              'shell.profile.deleteAccount.consequences.grace',
              'shell.profile.deleteAccount.consequences.removed',
              'shell.profile.deleteAccount.consequences.erased',
            ])
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.space8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '•',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: onContainer,
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space8),
                    Expanded(
                      child: Text(
                        key.tr(),
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: onContainer,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Tells the person to cancel an App Store / Google Play AI subscription in the store, with the
/// store's steps. Store names stay untranslated, as the stores show them.
class StoreSubscriptionWarningCard extends StatelessWidget {
  const StoreSubscriptionWarningCard({super.key, required this.subscriptions});

  final List<ActiveStoreSubscription> subscriptions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final semanticColors = theme.extension<AppSemanticColors>()!;
    final onContainer = semanticColors.onWarningContainer;
    final body = theme.textTheme.bodyMedium?.copyWith(color: onContainer);

    final own = subscriptions.where((s) => !s.forChild);
    final hasChild = subscriptions.any((s) => s.forChild);
    final platforms = subscriptions.map((s) => s.platform).toSet();
    const prefix = 'shell.profile.deleteAccount.storeWarning';

    return Card(
      key: const Key('deleteAccountStoreWarning'),
      margin: EdgeInsets.zero,
      color: semanticColors.warningContainer,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.credit_card_off_outlined, color: onContainer),
                const SizedBox(width: AppSpacing.space12),
                Expanded(
                  child: Semantics(
                    header: true,
                    child: Text(
                      '$prefix.title'.tr(),
                      style: theme.textTheme.titleMedium?.copyWith(
                        color: onContainer,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space12),
            if (own.isNotEmpty) ...[
              Text('$prefix.ownBody'.tr(), style: body),
              const SizedBox(height: AppSpacing.space8),
            ],
            if (own.any(
              (s) => s.platform == ActiveStoreSubscriptionPlatform.googlePlay,
            )) ...[
              Text('$prefix.googlePlayNote'.tr(), style: body),
              const SizedBox(height: AppSpacing.space8),
            ],
            if (hasChild) ...[
              Text('$prefix.childBody'.tr(), style: body),
              const SizedBox(height: AppSpacing.space8),
            ],
            Text('$prefix.stepsIntro'.tr(), style: body),
            const SizedBox(height: AppSpacing.space8),
            for (final step in [
              if (platforms.contains(ActiveStoreSubscriptionPlatform.appStore))
                '$prefix.appStoreSteps',
              if (platforms.contains(
                ActiveStoreSubscriptionPlatform.googlePlay,
              ))
                '$prefix.googlePlaySteps',
            ])
              Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.space8),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('•', style: body),
                    const SizedBox(width: AppSpacing.space8),
                    Expanded(child: Text(step.tr(), style: body)),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ConfirmDialog extends StatelessWidget {
  const _ConfirmDialog();

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return AlertDialog(
      title: Text('shell.profile.deleteAccount.dialog.title'.tr()),
      content: Text('shell.profile.deleteAccount.dialog.body'.tr()),
      actions: [
        TextButton(
          key: const Key('deleteAccountCancel'),
          onPressed: () => Navigator.of(context).pop(false),
          child: Text('shell.profile.deleteAccount.dialog.cancel'.tr()),
        ),
        FilledButton(
          key: const Key('deleteAccountDialogConfirm'),
          style: FilledButton.styleFrom(
            backgroundColor: colorScheme.error,
            foregroundColor: colorScheme.onError,
          ),
          onPressed: () => Navigator.of(context).pop(true),
          child: Text('shell.profile.deleteAccount.dialog.confirm'.tr()),
        ),
      ],
    );
  }
}

class _DoneDialog extends StatelessWidget {
  const _DoneDialog({required this.scheduledFor});

  final DateTime scheduledFor;

  @override
  Widget build(BuildContext context) {
    final date = DateFormat.yMMMMd(
      context.locale.toLanguageTag(),
    ).format(scheduledFor.toLocal());

    return AlertDialog(
      title: Text('shell.profile.deleteAccount.done.title'.tr()),
      content: Text(
        'shell.profile.deleteAccount.done.body'.tr(namedArgs: {'date': date}),
      ),
      actions: [
        FilledButton(
          key: const Key('deleteAccountDone'),
          onPressed: () => Navigator.of(context).pop(),
          child: Text('shell.profile.deleteAccount.done.ok'.tr()),
        ),
      ],
    );
  }
}

class _LoadError extends StatelessWidget {
  const _LoadError({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'shell.profile.deleteAccount.failed'.tr(),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AppSpacing.space12),
            TextButton(
              onPressed: onRetry,
              child: Text('shell.profile.deleteSchool.retry'.tr()),
            ),
          ],
        ),
      ),
    );
  }
}
