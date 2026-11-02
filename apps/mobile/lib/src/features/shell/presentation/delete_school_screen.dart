import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/auth/school_closed_notice.dart';
import '../../../design/tokens/app_radius_tokens.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../application/school_closure_providers.dart';

/// "Delete school": the school admin closes their school (`POST /api/schools/current/closure`).
///
/// Closing archives the school rather than erasing it: everyone at the school is signed out at
/// once and can no longer sign in, and all of the school's data is kept. The admin confirms by
/// typing the school's name; the button stays disabled until it matches the way the server
/// compares it. On success this device signs out through [AuthNotifier.logout] and the login
/// screen explains that the app is no longer available for the school.
class DeleteSchoolScreen extends ConsumerStatefulWidget {
  const DeleteSchoolScreen({super.key});

  @override
  ConsumerState<DeleteSchoolScreen> createState() => _DeleteSchoolScreenState();
}

class _DeleteSchoolScreenState extends ConsumerState<DeleteSchoolScreen> {
  final _nameController = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _nameController.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _close() async {
    final closeSchool = ref.read(closeSchoolProvider);
    final notice = ref.read(schoolClosedNoticeProvider.notifier);
    final auth = ref.read(authNotifierProvider.notifier);

    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await closeSchool(_nameController.text);
    } catch (error) {
      if (mounted) {
        setState(() {
          _submitting = false;
          _error = _messageFor(error);
        });
      }
      return;
    }

    // No pop: signing out sends the router's auth guard to the login screen, which replaces the
    // shell's page and, with it, this screen pushed on top of it.
    notice.show();
    await auth.logout();
  }

  static String _messageFor(Object error) {
    final apiError = error is DioException ? error.apiError : null;
    if (apiError?.code == 'SCHOOL_CLOSURE_NAME_MISMATCH') {
      return 'shell.profile.deleteSchool.nameMismatch'.tr();
    }
    return 'shell.profile.deleteSchool.failed'.tr();
  }

  @override
  Widget build(BuildContext context) {
    final school = ref.watch(currentSchoolProvider);

    return Scaffold(
      appBar: AppBar(title: Text('shell.profile.deleteSchool.title'.tr())),
      body: SafeArea(
        child: school.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, _) =>
              _LoadError(onRetry: () => ref.invalidate(currentSchoolProvider)),
          data: (school) => _form(context, school.name),
        ),
      ),
    );
  }

  Widget _form(BuildContext context, String schoolName) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final matches =
        normalizeSchoolName(_nameController.text) ==
        normalizeSchoolName(schoolName);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(AppSpacing.space16),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Card(
                margin: EdgeInsets.zero,
                color: colorScheme.errorContainer,
                child: Padding(
                  padding: const EdgeInsets.all(AppSpacing.space16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(
                            Icons.warning_amber_rounded,
                            color: colorScheme.onErrorContainer,
                          ),
                          const SizedBox(width: AppSpacing.space12),
                          Expanded(
                            child: Text(
                              'shell.profile.deleteSchool.warningTitle'.tr(),
                              style: theme.textTheme.titleMedium?.copyWith(
                                color: colorScheme.onErrorContainer,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: AppSpacing.space12),
                      for (final key in const [
                        'shell.profile.deleteSchool.consequences.signedOut',
                        'shell.profile.deleteSchool.consequences.noSignIn',
                        'shell.profile.deleteSchool.consequences.dataKept',
                      ])
                        Padding(
                          padding: const EdgeInsets.only(
                            bottom: AppSpacing.space8,
                          ),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '•',
                                style: theme.textTheme.bodyMedium?.copyWith(
                                  color: colorScheme.onErrorContainer,
                                ),
                              ),
                              const SizedBox(width: AppSpacing.space8),
                              Expanded(
                                child: Text(
                                  key.tr(),
                                  style: theme.textTheme.bodyMedium?.copyWith(
                                    color: colorScheme.onErrorContainer,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.space24),
              Text(
                'shell.profile.deleteSchool.confirmPrompt'.tr(),
                style: theme.textTheme.bodyMedium,
              ),
              const SizedBox(height: AppSpacing.space8),
              SelectableText(
                schoolName,
                key: const Key('deleteSchoolName'),
                style: theme.textTheme.titleMedium?.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: AppSpacing.space16),
              TextField(
                key: const Key('deleteSchoolNameField'),
                controller: _nameController,
                enabled: !_submitting,
                autocorrect: false,
                enableSuggestions: false,
                textInputAction: TextInputAction.done,
                decoration: InputDecoration(
                  labelText: 'shell.profile.deleteSchool.nameLabel'.tr(),
                  border: const OutlineInputBorder(),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: AppSpacing.space12),
                Text(
                  _error!,
                  key: const Key('deleteSchoolError'),
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colorScheme.error,
                  ),
                ),
              ],
              const SizedBox(height: AppSpacing.space24),
              FilledButton.icon(
                key: const Key('deleteSchoolConfirm'),
                style: FilledButton.styleFrom(
                  backgroundColor: colorScheme.error,
                  foregroundColor: colorScheme.onError,
                  minimumSize: const Size.fromHeight(48),
                  shape: const RoundedRectangleBorder(
                    borderRadius: AppRadius.mdRadius,
                  ),
                ),
                onPressed: matches && !_submitting ? _close : null,
                icon: _submitting
                    ? SizedBox.square(
                        dimension: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: colorScheme.onError,
                          semanticsLabel: 'shell.profile.deleteSchool.deleting'
                              .tr(),
                        ),
                      )
                    : const Icon(Icons.delete_forever_outlined),
                label: Text('shell.profile.deleteSchool.confirm'.tr()),
              ),
            ],
          ),
        ),
      ),
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
              'shell.profile.deleteSchool.loadFailed'.tr(),
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
