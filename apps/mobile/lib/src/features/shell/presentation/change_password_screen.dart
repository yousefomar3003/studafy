import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_client.dart';
import '../../../core/api/generated/models/member_password_change_request.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../design/tokens/app_spacing_tokens.dart';

const _memberRoles = {'STUDENT', 'PARENT', 'INSTRUCTOR', 'ATTENDANCE_OFFICER'};
const _privilegedRoles = {
  'SUPER_ADMIN',
  'ORG_ADMIN',
  'PRINCIPAL',
  'FINANCE',
  'SUPPORT_AGENT',
};

/// Whether this session signs in with a member ID and password, mirroring the API's rule
/// (`member-password-service.ts`): a member role and no leadership/platform role. Everyone else
/// signs in with Google or Microsoft and has no password to change.
bool canChangeMemberPassword(List<String> roleClaims) =>
    roleClaims.any(_memberRoles.contains) &&
    !roleClaims.any(_privilegedRoles.contains);

/// Settings → Change password: the signed-in member confirms their current password and picks a
/// new one (`POST /api/auth/password/change`).
class ChangePasswordScreen extends ConsumerStatefulWidget {
  const ChangePasswordScreen({super.key});

  @override
  ConsumerState<ChangePasswordScreen> createState() =>
      _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends ConsumerState<ChangePasswordScreen> {
  static const _minLength = 8;

  final _formKey = GlobalKey<FormState>();
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
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
          .read(apiClientProvider)
          .auth
          .changeMemberPassword(
            body: MemberPasswordChangeRequest(
              currentPassword: _current.text,
              newPassword: _next.text,
            ),
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('shell.profile.changePassword.saved'.tr())),
      );
      Navigator.of(context).pop();
    } catch (error) {
      if (mounted) setState(() => _error = _messageFor(error));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  static String _messageFor(Object error) {
    final apiError = error is DioException ? error.apiError : null;
    switch (apiError?.code) {
      case 'AUTH_INVALID_CREDENTIALS':
        return 'shell.profile.changePassword.wrongCurrent'.tr();
      case 'AUTH_ACCOUNT_LOCKED':
        return 'auth.memberForm.locked'.tr();
      case 'AUTH_PASSWORD_REJECTED':
        return apiError?.detail ?? 'auth.memberForm.passwordRejected'.tr();
    }
    return 'shell.profile.changePassword.error'.tr();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text('shell.profile.changePassword.title'.tr())),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.space16),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    TextFormField(
                      key: const Key('changePasswordCurrent'),
                      controller: _current,
                      enabled: !_submitting,
                      obscureText: true,
                      autofillHints: const [AutofillHints.password],
                      textInputAction: TextInputAction.next,
                      decoration: InputDecoration(
                        labelText: 'shell.profile.changePassword.current'.tr(),
                      ),
                      validator: (value) => (value ?? '').isEmpty
                          ? 'auth.emailForm.passwordRequired'.tr()
                          : null,
                    ),
                    const SizedBox(height: AppSpacing.space12),
                    TextFormField(
                      key: const Key('changePasswordNew'),
                      controller: _next,
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
                      key: const Key('changePasswordConfirm'),
                      controller: _confirm,
                      enabled: !_submitting,
                      obscureText: true,
                      autofillHints: const [AutofillHints.newPassword],
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _submit(),
                      decoration: InputDecoration(
                        labelText: 'auth.memberForm.confirmPassword'.tr(),
                      ),
                      validator: (value) => value != _next.text
                          ? 'auth.memberForm.mismatch'.tr()
                          : null,
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: AppSpacing.space12),
                      Text(
                        _error!,
                        key: const Key('changePasswordError'),
                        style: TextStyle(color: theme.colorScheme.error),
                      ),
                    ],
                    const SizedBox(height: AppSpacing.space16),
                    FilledButton(
                      key: const Key('changePasswordSubmit'),
                      style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(48),
                      ),
                      onPressed: _submitting ? null : _submit,
                      child: _submitting
                          ? const SizedBox.square(
                              dimension: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Text('shell.profile.changePassword.submit'.tr()),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
