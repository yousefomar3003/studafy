import 'package:dio/dio.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/generated/models/attendance_record.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../student/presentation/widgets/attendance_status_pill.dart';
import '../../teacher/domain/attendance_taking.dart';
import '../../teacher/presentation/widgets/attendance_correction_sheet.dart';
import '../../teacher/presentation/widgets/attendance_status_chip.dart';
import '../../teacher/presentation/widgets/attendance_submit_bar.dart';
import '../application/attendance_office_providers.dart';
import '../data/attendance_office_client.dart';
import '../domain/attendance_office.dart';

/// One class's daily register on one date, for the attendance office.
///
/// Before submission every student not yet recorded gets a status — present by default, so a
/// full class is one tap on "Submit register" — and submit opens the day's session if needed,
/// records the marks in batches and submits it. Students someone already recorded (a teacher who
/// started the register on mobile) show as recorded and are not re-sent. Once submitted the
/// register is read-only and each record has "Correct", which opens the shared correction sheet.
///
/// Submitting needs a connection: it is online-only (no outbox), and a failure keeps every mark
/// on screen so a retry finishes the job — each step is idempotent server-side. The mobile twin
/// of `apps/web/src/features/attendance-office/RegisterPage.tsx`.
///
/// Teachers take their own classes' registers through the same screen with [canCorrect] off:
/// corrections stay with the attendance office and the principal, so a submitted register is
/// read-only for them.
class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({
    required this.classId,
    required this.classCode,
    required this.date,
    this.canCorrect = true,
    super.key,
  });

  final String classId;
  final String classCode;
  final DateTime date;

  /// Whether a submitted register offers "Correct" on each record (the caller can correct).
  final bool canCorrect;

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final Map<String, OfficeMark> _marks = {};
  bool _submitting = false;
  bool _showValidation = false;

  OfficeRegisterScope get _scope =>
      (classId: widget.classId, date: dateOnly(widget.date));

  OfficeMark _markOf(String studentId) =>
      _marks[studentId] ?? OfficeMark.present;

  void _refresh(OfficeRegister? register) {
    ref
      ..invalidate(officeRosterProvider(widget.classId))
      ..invalidate(dailySessionsProvider(_scope.date));
    final sessionId = register?.session?.id;
    if (sessionId != null) {
      ref.invalidate(officeSessionRecordsProvider(sessionId));
    }
  }

  @override
  Widget build(BuildContext context) {
    final registerAsync = ref.watch(officeRegisterProvider(_scope));
    final names =
        ref.watch(officeStudentNamesProvider(widget.classId)).value ??
        const <String, String>{};
    final dateLabel = DateFormat.yMMMEd(
      context.locale.toString(),
    ).format(widget.date);

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(widget.classCode),
            Text(dateLabel, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
      body: registerAsync.when(
        skipLoadingOnRefresh: true,
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => _Message(
          icon: Icons.error_outline,
          message: 'attendanceOffice.register.error'.tr(),
          onRetry: () {
            ref.invalidate(officeStudentNamesProvider(widget.classId));
            _refresh(registerAsync.value);
          },
        ),
        data: (register) {
          if (register.rosterStudentIds.isEmpty && register.records.isEmpty) {
            return _Message(
              icon: Icons.group_off_outlined,
              message: 'attendanceOffice.register.empty'.tr(),
            );
          }
          return register.isSubmitted
              ? _buildSubmitted(register, names)
              : _buildTaking(register, names);
        },
      ),
    );
  }

  // --- Taking --------------------------------------------------------------

  Widget _buildTaking(OfficeRegister register, Map<String, String> names) {
    final toMark = register.toMark;
    final recorded = register.recordByStudent;
    final tally = AttendanceTally.of([
      for (final id in toMark) _markOf(id).toAttendanceMark(id),
    ]);

    return Column(
      children: [
        _Banner(text: 'attendanceOffice.register.description'.tr()),
        if (toMark.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.space16,
              AppSpacing.space8,
              AppSpacing.space16,
              0,
            ),
            child: Align(
              alignment: AlignmentDirectional.centerEnd,
              child: OutlinedButton.icon(
                icon: const Icon(Icons.done_all, size: 18),
                label: Text('attendanceOffice.register.markAllPresent'.tr()),
                onPressed: _submitting
                    ? null
                    : () => setState(() {
                        for (final id in toMark) {
                          _marks[id] = OfficeMark.present;
                        }
                      }),
              ),
            ),
          ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () async => _refresh(register),
            child: ListView.builder(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.space16,
              ),
              itemCount: register.rosterStudentIds.length,
              itemBuilder: (context, index) {
                final studentId = register.rosterStudentIds[index];
                final name = _nameOf(studentId, names);
                final record = recorded[studentId];
                if (record != null) {
                  return _RecordedRow(
                    name: name,
                    record: record,
                    trailingNote: 'attendanceOffice.register.alreadyRecorded'
                        .tr(),
                  );
                }
                return _MarkRow(
                  key: ValueKey('mark-$studentId'),
                  studentId: studentId,
                  name: name,
                  mark: _markOf(studentId),
                  enabled: !_submitting,
                  showValidation: _showValidation,
                  onChanged: (mark) => setState(() => _marks[studentId] = mark),
                );
              },
            ),
          ),
        ),
        AttendanceSubmitBar(
          tally: tally,
          isSubmitting: _submitting,
          hasPendingSync: false,
          submitLabel: 'attendanceOffice.register.submit'.tr(
            namedArgs: {'count': '${toMark.length}'},
          ),
          onSubmit: () => _submit(register),
          onRetrySync: () {},
        ),
      ],
    );
  }

  Future<void> _submit(OfficeRegister register) async {
    if (_submitting) return;
    final toMark = register.toMark;

    if (toMark.any((id) => !_markOf(id).isValid)) {
      setState(() => _showValidation = true);
      _snack('attendanceOffice.register.lateNeedsMinutes'.tr());
      return;
    }

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('attendanceOffice.register.confirmTitle'.tr()),
        content: Text(
          'attendanceOffice.register.confirmBody'.tr(
            namedArgs: {
              'count': '${toMark.length}',
              'class': widget.classCode,
              'date': DateFormat.yMMMd(
                context.locale.toString(),
              ).format(widget.date),
            },
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text('attendanceOffice.register.cancel'.tr()),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text('attendanceOffice.register.confirm'.tr()),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() => _submitting = true);
    try {
      final sessionId = await submitOfficeRegister(
        ref.read(attendanceOfficeClientProvider),
        classId: widget.classId,
        date: _scope.date,
        existingSession: register.session,
        records: [
          for (final id in toMark) OfficeBatchItem.fromMark(id, _markOf(id)),
        ],
      );
      if (!mounted) return;
      setState(() {
        _marks.clear();
        _showValidation = false;
      });
      ref
        ..invalidate(dailySessionsProvider(_scope.date))
        ..invalidate(officeSessionRecordsProvider(sessionId));
      _snack('attendanceOffice.register.submitted'.tr());
    } on RegisterCancelledException {
      if (!mounted) return;
      _snack('attendanceOffice.register.cancelled'.tr());
      _refresh(register);
    } on DioException catch (error) {
      if (!mounted) return;
      final apiError = error.apiError;
      _snack(
        apiError == null
            ? 'attendanceOffice.register.offline'.tr()
            : apiError.code == null
            ? 'attendanceOffice.register.submitFailedGeneric'.tr()
            : 'attendanceOffice.register.submitFailed'.tr(
                namedArgs: {'code': apiError.code!},
              ),
      );
    } catch (_) {
      if (mounted) _snack('attendanceOffice.register.submitFailedGeneric'.tr());
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // --- Submitted -----------------------------------------------------------

  Widget _buildSubmitted(OfficeRegister register, Map<String, String> names) {
    final recorded = register.recordByStudent;
    final rosterIds = register.rosterStudentIds.toSet();
    // Records for students no longer on the roster stay correctable too.
    final ids = [
      ...register.rosterStudentIds,
      for (final record in register.records)
        if (!rosterIds.contains(record.studentId)) record.studentId,
    ];

    return Column(
      children: [
        _Banner(
          text: widget.canCorrect
              ? 'attendanceOffice.register.submittedDescription'.tr()
              : 'attendanceOffice.register.submittedReadOnly'.tr(),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () async => _refresh(register),
            child: ListView.builder(
              physics: const AlwaysScrollableScrollPhysics(),
              padding:
                  const EdgeInsets.symmetric(
                    horizontal: AppSpacing.space16,
                  ).copyWith(
                    bottom:
                        AppSpacing.space16 +
                        MediaQuery.paddingOf(context).bottom,
                  ),
              itemCount: ids.length,
              itemBuilder: (context, index) {
                final studentId = ids[index];
                final name = _nameOf(studentId, names);
                final record = recorded[studentId];
                if (record == null) {
                  return _RecordedRow(
                    name: name,
                    record: null,
                    trailingNote: 'attendanceOffice.register.notRecorded'.tr(),
                  );
                }
                return _RecordedRow(
                  name: name,
                  record: record,
                  onCorrect: widget.canCorrect
                      ? () => _openCorrection(record, name)
                      : null,
                );
              },
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _openCorrection(AttendanceRecord record, String name) async {
    final saved = await AttendanceCorrectionSheet.show(
      context,
      record: record,
      studentLabel: name,
      windowExpiredMessageKey: 'attendanceOffice.register.windowExpired',
    );
    if (saved == true && mounted) {
      ref.invalidate(officeSessionRecordsProvider(record.attendanceSessionId));
      _snack('attendanceOffice.register.corrected'.tr());
    }
  }

  // --- Helpers -------------------------------------------------------------

  String _nameOf(String studentId, Map<String, String> names) =>
      names[studentId] ??
      'teacher.class.unknownStudent'.tr(
        namedArgs: {
          'id': studentId.length <= 6
              ? studentId
              : studentId.substring(studentId.length - 6),
        },
      );

  void _snack(String message) {
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }
}

/// The statuses the office marks, in the order offered. `remote` is display-only here: it can
/// appear on a record taken elsewhere, but is never set from the office register.
const _markable = AttendanceMarkStatus.values;

/// One not-yet-recorded student: name, a four-way status selector and, for late, minutes.
class _MarkRow extends StatelessWidget {
  const _MarkRow({
    required this.studentId,
    required this.name,
    required this.mark,
    required this.enabled,
    required this.showValidation,
    required this.onChanged,
    super.key,
  });

  final String studentId;
  final String name;
  final OfficeMark mark;
  final bool enabled;
  final bool showValidation;
  final ValueChanged<OfficeMark> onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isLate = mark.status == AttendanceMarkStatus.late;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  name,
                  style: theme.textTheme.bodyLarge,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (isLate)
                SizedBox(
                  width: 104,
                  child: TextFormField(
                    key: ValueKey('minutes-$studentId'),
                    initialValue: mark.minutesLateText,
                    enabled: enabled,
                    keyboardType: TextInputType.number,
                    inputFormatters: [
                      FilteringTextInputFormatter.digitsOnly,
                      LengthLimitingTextInputFormatter(3),
                    ],
                    decoration: InputDecoration(
                      labelText: 'attendanceOffice.register.minutesLate'.tr(),
                      isDense: true,
                      border: const OutlineInputBorder(),
                      errorText: showValidation && !mark.isValid
                          ? 'attendanceOffice.register.minutesLateInvalid'.tr()
                          : null,
                    ),
                    onChanged: (value) =>
                        onChanged(mark.copyWith(minutesLateText: value)),
                  ),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.space4),
          Wrap(
            spacing: AppSpacing.space8,
            runSpacing: AppSpacing.space4,
            children: [
              for (final status in _markable)
                _StatusOption(
                  studentName: name,
                  status: status,
                  selected: mark.status == status,
                  onSelected: enabled
                      ? () => onChanged(mark.copyWith(status: status))
                      : null,
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// One status choice. Announced as "Attendance for {student}: {status}" so a screen-reader user
/// hears whose row they are on, not just a bare "Absent".
class _StatusOption extends StatelessWidget {
  const _StatusOption({
    required this.studentName,
    required this.status,
    required this.selected,
    required this.onSelected,
  });

  final String studentName;
  final AttendanceMarkStatus status;
  final bool selected;
  final VoidCallback? onSelected;

  @override
  Widget build(BuildContext context) {
    final label = AttendanceStatusChip.labelKeyFor(status).tr();
    return Semantics(
      container: true,
      label: 'attendanceOffice.register.statusFor'.tr(
        namedArgs: {'student': studentName, 'status': label},
      ),
      button: true,
      selected: selected,
      inMutuallyExclusiveGroup: true,
      enabled: onSelected != null,
      onTap: onSelected,
      excludeSemantics: true,
      child: ChoiceChip(
        label: Text(label),
        selected: selected,
        onSelected: onSelected == null ? null : (_) => onSelected!(),
      ),
    );
  }
}

/// A student with a record (or, on a submitted register, without one): status pill, minutes
/// late, and either a note or the Correct action.
class _RecordedRow extends StatelessWidget {
  const _RecordedRow({
    required this.name,
    required this.record,
    this.trailingNote,
    this.onCorrect,
  });

  final String name;
  final AttendanceRecord? record;
  final String? trailingNote;
  final VoidCallback? onCorrect;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final record = this.record;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space8),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, style: theme.textTheme.bodyLarge, maxLines: 1),
                if (record?.minutesLate != null)
                  Text(
                    'attendance.lateBy'.tr(
                      namedArgs: {'minutes': '${record!.minutesLate}'},
                    ),
                    style: muted,
                  ),
                if (trailingNote != null) Text(trailingNote!, style: muted),
              ],
            ),
          ),
          if (record != null) ...[
            const SizedBox(width: AppSpacing.space8),
            AttendanceStatusPill(status: record.status),
          ],
          if (onCorrect != null) ...[
            const SizedBox(width: AppSpacing.space4),
            Semantics(
              container: true,
              label: 'attendanceOffice.register.correctLabel'.tr(
                namedArgs: {'student': name},
              ),
              button: true,
              excludeSemantics: true,
              onTap: onCorrect,
              child: TextButton(
                onPressed: onCorrect,
                child: Text('attendanceOffice.register.correct'.tr()),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      color: theme.colorScheme.surfaceContainerHighest,
      padding: const EdgeInsets.all(AppSpacing.space12),
      child: Text(text, style: theme.textTheme.bodySmall),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.message, this.onRetry});

  final IconData icon;
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 32, color: colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: colorScheme.onSurfaceVariant,
              ),
            ),
            if (onRetry != null) ...[
              const SizedBox(height: AppSpacing.space12),
              OutlinedButton(
                onPressed: onRetry,
                child: Text('attendanceOffice.register.retry'.tr()),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
