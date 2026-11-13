import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../core/auth/auth_notifier.dart';
import '../../../../core/auth/saved_account.dart';
import '../../../shell/application/shell_providers.dart';
import '../../application/child_device_providers.dart';

/// "Add (name) to this phone" / "Open (name)" for one linked child.
///
/// Adding puts the child's own account in the account switcher with one tap, using the parent's
/// sign-in (no member ID, no password); opening switches to it, so the child uses their own app as
/// themselves. The school can turn adding off, which the API answers with AUTHZ_FORBIDDEN.
class ChildPhoneAccountButton extends ConsumerStatefulWidget {
  const ChildPhoneAccountButton({
    required this.studentId,
    required this.childName,
    super.key,
  });

  final String studentId;
  final String childName;

  @override
  ConsumerState<ChildPhoneAccountButton> createState() =>
      _ChildPhoneAccountButtonState();
}

class _ChildPhoneAccountButtonState
    extends ConsumerState<ChildPhoneAccountButton> {
  bool _busy = false;

  String get _firstName {
    final name = widget.childName.trim();
    return name.isEmpty ? name : name.split(RegExp(r'\s+')).first;
  }

  /// How the parent's own account is listed once the child's takes over.
  AccountLabel _parentLabel() {
    final profile = ref.read(accountProfileProvider).value;
    return AccountLabel(
      displayName: profile?.displayName,
      schoolName: profile?.school.name,
      memberIds: profile?.memberIds ?? const [],
    );
  }

  Future<void> _open(String childUserId) async {
    setState(() => _busy = true);
    final opened = await ref
        .read(authNotifierProvider.notifier)
        .switchTo(childUserId, current: _parentLabel());
    if (!mounted) return;
    setState(() => _busy = false);
    if (!opened) _snack('parent.childDevice.expired'.tr());
  }

  Future<void> _add() async {
    setState(() => _busy = true);
    try {
      final childUserId = await ref
          .read(childDeviceAccountsProvider.notifier)
          .add(widget.studentId);
      if (!mounted) return;
      _snack(
        'parent.childDevice.added'.tr(namedArgs: {'name': _firstName}),
        action: SnackBarAction(
          label: 'parent.childDevice.openNow'.tr(),
          onPressed: () => _open(childUserId),
        ),
      );
    } on DioException catch (error) {
      if (mounted) _snack(_errorKey(error).tr());
    } catch (_) {
      if (mounted) _snack('parent.childDevice.errors.generic'.tr());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _snack(String message, {SnackBarAction? action}) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message), action: action));
  }

  @override
  Widget build(BuildContext context) {
    final childUserId = ref.watch(
      childAccountOnPhoneProvider(widget.studentId),
    );
    final onPhone = childUserId != null;
    final label = onPhone
        ? 'parent.childDevice.open'.tr(namedArgs: {'name': _firstName})
        : 'parent.childDevice.add'.tr(namedArgs: {'name': _firstName});

    return OutlinedButton.icon(
      key: Key('childPhoneAccount-${widget.studentId}'),
      onPressed: _busy ? null : () => onPhone ? _open(childUserId) : _add(),
      icon: _busy
          ? const SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          : Icon(onPhone ? Icons.switch_account_outlined : Icons.phone_iphone),
      label: Text(label),
    );
  }
}

String _errorKey(DioException error) {
  final apiError = error.apiError;
  return switch (apiError?.code) {
    'AUTHZ_FORBIDDEN' => 'parent.childDevice.errors.disabled',
    'AUTH_ACCOUNT_LOCKED' => 'parent.childDevice.errors.locked',
    'GUARDIAN_CHILD_UNAVAILABLE' => 'parent.childDevice.errors.unavailable',
    'RESOURCE_NOT_FOUND' => 'parent.childDevice.errors.notLinked',
    _ => switch (apiError?.status ?? error.response?.statusCode) {
      429 => 'parent.childDevice.errors.tooMany',
      _ => 'parent.childDevice.errors.generic',
    },
  };
}
