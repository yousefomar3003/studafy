import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/parent_providers.dart';

/// Pushes [AttendanceAlertThresholdSheet] as a modal bottom sheet — the alerts tab's "threshold
/// settings" shortcut.
Future<void> showAttendanceAlertThresholdSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => const AttendanceAlertThresholdSheet(),
  );
}

/// Edits the parent's personal attendance-alert threshold — an absence-count override on top of
/// the school's own configured rules (`PATCH /api/notification-preferences`). Loads the current
/// value from [notificationPreferencesProvider], round-trips a save through
/// [attendanceAlertThresholdControllerProvider], and closes on success.
class AttendanceAlertThresholdSheet extends ConsumerWidget {
  const AttendanceAlertThresholdSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space16),
          child: ref.watch(notificationPreferencesProvider).when(
                loading: () => const Padding(
                  padding: EdgeInsets.symmetric(vertical: AppSpacing.space32),
                  child: Center(child: CircularProgressIndicator()),
                ),
                error: (_, _) => Text('parent.communication.threshold.error'.tr()),
                data: (preferences) =>
                    _ThresholdForm(initialThreshold: preferences.attendanceAlertThreshold),
              ),
        ),
      ),
    );
  }
}

class _ThresholdForm extends ConsumerStatefulWidget {
  const _ThresholdForm({required this.initialThreshold});

  final int? initialThreshold;

  @override
  ConsumerState<_ThresholdForm> createState() => _ThresholdFormState();
}

class _ThresholdFormState extends ConsumerState<_ThresholdForm> {
  static const _minDays = 1;
  static const _maxDays = 365;

  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _daysController;
  late bool _useSchoolDefault;
  String? _errorKey;

  @override
  void initState() {
    super.initState();
    _useSchoolDefault = widget.initialThreshold == null;
    _daysController = TextEditingController(
      text: (widget.initialThreshold ?? _minDays).toString(),
    );
  }

  @override
  void dispose() {
    _daysController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_useSchoolDefault && !(_formKey.currentState?.validate() ?? false)) return;

    setState(() => _errorKey = null);

    final days = _useSchoolDefault ? null : int.parse(_daysController.text.trim());
    await ref.read(attendanceAlertThresholdControllerProvider.notifier).setThreshold(days);

    final result = ref.read(attendanceAlertThresholdControllerProvider);
    if (!mounted) return;

    result.when(
      data: (_) => Navigator.of(context).pop(),
      loading: () {},
      error: (error, _) {
        final code = error is DioException ? error.apiError?.code : null;
        setState(() {
          _errorKey = code == 'VALIDATION_FAILED'
              ? 'parent.communication.threshold.errorValidation'
              : 'parent.communication.threshold.errorGeneric';
        });
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isSaving = ref.watch(attendanceAlertThresholdControllerProvider).isLoading;

    return Form(
      key: _formKey,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'parent.communication.threshold.title'.tr(),
            style: theme.textTheme.titleMedium,
          ),
          const SizedBox(height: AppSpacing.space8),
          Text(
            'parent.communication.threshold.description'.tr(),
            style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
          const SizedBox(height: AppSpacing.space16),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: Text('parent.communication.threshold.useSchoolDefault'.tr()),
            value: _useSchoolDefault,
            onChanged: isSaving
                ? null
                : (value) => setState(() => _useSchoolDefault = value),
          ),
          if (!_useSchoolDefault) ...[
            const SizedBox(height: AppSpacing.space8),
            TextFormField(
              controller: _daysController,
              enabled: !isSaving,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                labelText: 'parent.communication.threshold.daysField'.tr(),
              ),
              validator: (value) {
                final parsed = int.tryParse(value?.trim() ?? '');
                if (parsed == null || parsed < _minDays || parsed > _maxDays) {
                  return 'parent.communication.threshold.daysInvalid'.tr(
                    namedArgs: {'min': '$_minDays', 'max': '$_maxDays'},
                  );
                }
                return null;
              },
            ),
          ],
          if (_errorKey != null) ...[
            const SizedBox(height: AppSpacing.space8),
            Text(
              _errorKey!.tr(),
              style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error),
            ),
          ],
          const SizedBox(height: AppSpacing.space20),
          FilledButton(
            onPressed: isSaving ? null : _save,
            child: isSaving
                ? const SizedBox.square(
                    dimension: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text('parent.communication.threshold.save'.tr()),
          ),
        ],
      ),
    );
  }
}
