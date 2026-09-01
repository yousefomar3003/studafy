import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/api/api_exception.dart';
import '../../../../core/api/generated/models/attendance_record.dart';
import '../../../../core/api/generated/models/attendance_record_status.dart';
import '../../../../core/api/generated/models/correct_attendance_record_body.dart';
import '../../../../core/api/generated/models/correct_attendance_record_body_status.dart';
import '../../../../core/api/generated/models/corrected_attendance_record.dart';
import '../../../../core/auth/auth_providers.dart';
import '../../../../design/tokens/app_spacing_tokens.dart';
import '../../application/attendance_sync_queue.dart';
import '../../application/attendance_taking_providers.dart';
import '../../domain/attendance_taking.dart';
import 'attendance_status_chip.dart';

/// Bottom sheet for amending one already-submitted attendance record via
/// `PATCH /api/attendance/records/{recordId}`.
///
/// Corrections are online-only — they are rare, need a written reason, and their conflict
/// semantics don't fit a replay queue — so this does not touch the outbox. It updates the local
/// records cache on success so the change shows without the (non-existent) "list records" call.
class AttendanceCorrectionSheet extends ConsumerStatefulWidget {
  const AttendanceCorrectionSheet({
    required this.record,
    required this.studentLabel,
    required this.scope,
    super.key,
  });

  final AttendanceRecord record;
  final String studentLabel;
  final AttendanceScope scope;

  /// Opens the sheet. Resolves true once a correction has been saved.
  static Future<bool?> show(
    BuildContext context, {
    required AttendanceRecord record,
    required String studentLabel,
    required AttendanceScope scope,
  }) {
    return showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => AttendanceCorrectionSheet(
        record: record,
        studentLabel: studentLabel,
        scope: scope,
      ),
    );
  }

  @override
  ConsumerState<AttendanceCorrectionSheet> createState() => _AttendanceCorrectionSheetState();
}

class _AttendanceCorrectionSheetState extends ConsumerState<AttendanceCorrectionSheet> {
  final _reasonController = TextEditingController();
  late final AttendanceMarkStatus _current =
      AttendanceMarkStatus.fromRecord(widget.record.status);

  AttendanceMarkStatus? _choice;
  int _minutesLate = kMinMinutesLate;
  bool _submitting = false;
  String? _errorKey;

  @override
  void initState() {
    super.initState();
    _minutesLate = widget.record.minutesLate ?? kMinMinutesLate;
    _reasonController.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  bool get _canSave =>
      !_submitting && _choice != null && _reasonController.text.trim().isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final choices =
        AttendanceMarkStatus.values.where((status) => status != _current).toList();

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('teacher.attendance.correction.title'.tr(), style: theme.textTheme.titleMedium),
            const SizedBox(height: AppSpacing.space4),
            Row(
              children: [
                Expanded(
                  child: Text(
                    widget.studentLabel,
                    style: theme.textTheme.bodyMedium,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: AppSpacing.space8),
                AttendanceStatusChip(status: _current),
              ],
            ),
            const SizedBox(height: AppSpacing.space16),
            Text(
              'teacher.attendance.correction.newStatus'.tr(),
              style: theme.textTheme.labelMedium,
            ),
            const SizedBox(height: AppSpacing.space8),
            Wrap(
              spacing: AppSpacing.space8,
              children: [
                for (final status in choices)
                  ChoiceChip(
                    label: Text(AttendanceStatusChip.labelKeyFor(status).tr()),
                    selected: _choice == status,
                    onSelected: _submitting
                        ? null
                        : (_) => setState(() => _choice = status),
                  ),
              ],
            ),
            if (_choice == AttendanceMarkStatus.late) ...[
              const SizedBox(height: AppSpacing.space12),
              _MinutesLateField(
                minutes: _minutesLate,
                onChanged: (value) => setState(() => _minutesLate = value),
              ),
            ],
            const SizedBox(height: AppSpacing.space16),
            TextField(
              controller: _reasonController,
              enabled: !_submitting,
              maxLength: 500,
              minLines: 2,
              maxLines: 4,
              decoration: InputDecoration(
                labelText: 'teacher.attendance.correction.reason'.tr(),
                border: const OutlineInputBorder(),
              ),
            ),
            if (_errorKey != null) ...[
              const SizedBox(height: AppSpacing.space8),
              Text(
                _errorKey!.tr(),
                style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.error),
              ),
            ],
            const SizedBox(height: AppSpacing.space12),
            FilledButton(
              onPressed: _canSave ? _save : null,
              child: _submitting
                  ? const SizedBox.square(
                      dimension: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Text('teacher.attendance.correction.save'.tr()),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _save() async {
    final choice = _choice;
    if (choice == null) return;

    setState(() {
      _submitting = true;
      _errorKey = null;
    });

    try {
      final corrected = await ref.read(apiClientProvider).attendance.correctAttendanceRecord(
        recordId: widget.record.id,
        body: CorrectAttendanceRecordBody(
          status: _toWireStatus(choice),
          reason: _reasonController.text.trim(),
          minutesLate: choice == AttendanceMarkStatus.late ? _minutesLate : null,
        ),
      );

      await ref
          .read(attendanceSyncQueueProvider)
          .replaceCachedRecord(widget.record.attendanceSessionId, _asRecord(corrected));
      ref.invalidate(attendanceRegisterProvider(widget.scope));

      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (error) {
      setState(() {
        _submitting = false;
        _errorKey = _errorKeyFor(error);
      });
    } catch (_) {
      setState(() {
        _submitting = false;
        _errorKey = 'teacher.attendance.correction.failed';
      });
    }
  }

  CorrectAttendanceRecordBodyStatus _toWireStatus(AttendanceMarkStatus status) => switch (status) {
    AttendanceMarkStatus.present => CorrectAttendanceRecordBodyStatus.present,
    AttendanceMarkStatus.absent => CorrectAttendanceRecordBodyStatus.absent,
    AttendanceMarkStatus.late => CorrectAttendanceRecordBodyStatus.valueLate,
    AttendanceMarkStatus.excused => CorrectAttendanceRecordBodyStatus.excused,
  };

  AttendanceRecord _asRecord(CorrectedAttendanceRecord corrected) => AttendanceRecord(
    id: corrected.id,
    schoolId: corrected.schoolId,
    attendanceSessionId: corrected.attendanceSessionId,
    studentId: corrected.studentId,
    status: AttendanceRecordStatus.fromJson(corrected.status.json ?? 'present'),
    minutesLate: corrected.minutesLate,
    reason: corrected.reason,
    recordedByUserId: corrected.recordedByUserId,
    createdAt: corrected.createdAt,
  );

  String _errorKeyFor(DioException error) {
    switch (error.apiError?.code) {
      case 'ATTENDANCE_CORRECTION_WINDOW_EXPIRED':
        return 'teacher.attendance.correction.windowExpired';
      case 'ATTENDANCE_RECORD_FORBIDDEN':
      case 'ATTENDANCE_RECORD_NOT_FOUND':
        return 'teacher.attendance.correction.forbidden';
      case 'ATTENDANCE_CORRECTION_NO_CHANGE':
        return 'teacher.attendance.correction.noChange';
    }
    return error.apiError == null
        ? 'teacher.attendance.offline'
        : 'teacher.attendance.correction.failed';
  }
}

/// A labelled number field for the minutes-late value, floored at [kMinMinutesLate].
class _MinutesLateField extends StatelessWidget {
  const _MinutesLateField({required this.minutes, required this.onChanged});

  final int minutes;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Text('attendance.status.late'.tr(), style: Theme.of(context).textTheme.labelMedium),
        const SizedBox(width: AppSpacing.space12),
        IconButton(
          onPressed: minutes > kMinMinutesLate ? () => onChanged(minutes - 1) : null,
          icon: const Icon(Icons.remove),
          visualDensity: VisualDensity.compact,
        ),
        Text('$minutes', style: Theme.of(context).textTheme.bodyMedium),
        IconButton(
          onPressed: minutes < 240 ? () => onChanged(minutes + 1) : null,
          icon: const Icon(Icons.add),
          visualDensity: VisualDensity.compact,
        ),
        Text('teacher.attendance.minutesUnit'.tr(), style: Theme.of(context).textTheme.bodySmall),
      ],
    );
  }
}
