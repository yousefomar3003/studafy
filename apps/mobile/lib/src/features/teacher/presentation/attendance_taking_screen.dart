import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/generated/models/attendance_record.dart';
import '../../../design/tokens/app_spacing_tokens.dart';
import '../../student/presentation/widgets/attendance_status_pill.dart';
import '../application/attendance_sync_queue.dart';
import '../application/attendance_taking_providers.dart';
import '../application/teacher_providers.dart';
import '../domain/attendance_sync.dart';
import '../domain/attendance_taking.dart';
import 'widgets/attendance_correction_sheet.dart';
import 'widgets/attendance_roster_row.dart';
import 'widgets/attendance_submit_bar.dart';

/// Take attendance for one class on today's date.
///
/// The roster loads with every student marked present; a tap on a row cycles that student's
/// state. Submit opens today's session (idempotent), records the batch (idempotent per student),
/// and moves the session to `submitted` so the records become correctable. If the network is
/// down, the register is held in a local outbox and replayed on the next screen open, app resume,
/// or an explicit retry — the server's idempotency makes that replay exactly-once.
///
/// Once today's session is submitted the screen switches to a recorded view: each student shows
/// their recorded state, and a tap opens the correction sheet (within the school's correction
/// window).
class AttendanceTakingScreen extends ConsumerStatefulWidget {
  const AttendanceTakingScreen({
    required this.classId,
    required this.classCode,
    this.period,
    super.key,
  });

  final String classId;
  final String classCode;

  /// The timetable period this register is for, or null for whole-day attendance taken from the
  /// class screen.
  final int? period;

  @override
  ConsumerState<AttendanceTakingScreen> createState() => _AttendanceTakingScreenState();
}

class _AttendanceTakingScreenState extends ConsumerState<AttendanceTakingScreen>
    with WidgetsBindingObserver {
  final Map<String, AttendanceMark> _draft = {};
  bool _submitting = false;
  bool _deferred = false;

  AttendanceScope get _scope => (classId: widget.classId, period: widget.period);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _replayPending());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The app has no connectivity stream; a return to the foreground is the closest signal that
    // the network may be back.
    if (state == AppLifecycleState.resumed) _replayPending();
  }

  @override
  Widget build(BuildContext context) {
    final registerAsync = ref.watch(attendanceRegisterProvider(_scope));

    return Scaffold(
      appBar: AppBar(title: Text(widget.classCode)),
      body: registerAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (_, _) => _ErrorRetry(
          onRetry: () => ref.invalidate(attendanceRegisterProvider(_scope)),
        ),
        data: (register) => switch (register) {
          AttendanceTakingRegister taking => _buildTaking(taking),
          RecordedRegister recorded => _buildRecorded(recorded),
        },
      ),
    );
  }

  // --- Taking --------------------------------------------------------------

  Widget _buildTaking(AttendanceTakingRegister register) {
    _reconcileDraft(register);

    final editable = register.editableRoster.toList();
    if (editable.isEmpty && register.lockedRecords.isEmpty) {
      return const _CenteredMessage(
        icon: Icons.group_off_outlined,
        messageKey: 'teacher.class.rosterEmpty',
      );
    }

    final marks = [
      for (final enrolment in editable)
        _draft[enrolment.studentId] ?? AttendanceMark.present(enrolment.studentId),
    ];

    return Column(
      children: [
        _ScopeHeader(period: widget.period),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () async => ref.invalidate(attendanceRegisterProvider(_scope)),
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16),
              children: [
                for (final record in register.lockedRecords)
                  _LockedRow(record: record),
                for (final enrolment in editable)
                  AttendanceRosterRow(
                    studentId: enrolment.studentId,
                    mark: _draft[enrolment.studentId] ??
                        AttendanceMark.present(enrolment.studentId),
                    onCycle: () => _cycle(enrolment.studentId),
                    onMinutesLateChanged: (minutes) =>
                        _setMinutesLate(enrolment.studentId, minutes),
                  ),
              ],
            ),
          ),
        ),
        AttendanceSubmitBar(
          tally: AttendanceTally.of(marks),
          isSubmitting: _submitting,
          hasPendingSync: _deferred,
          onSubmit: editable.isEmpty ? _noop : () => _submit(register),
          onRetrySync: () => _replayPending(announce: true),
        ),
      ],
    );
  }

  void _reconcileDraft(AttendanceTakingRegister register) {
    final editableIds = {for (final e in register.editableRoster) e.studentId};
    var changed = false;

    for (final id in editableIds) {
      if (!_draft.containsKey(id)) {
        _draft[id] = AttendanceMark.present(id);
        changed = true;
      }
    }
    _draft.keys.where((id) => !editableIds.contains(id)).toList().forEach((id) {
      _draft.remove(id);
      changed = true;
    });

    if (changed && mounted) {
      // Called from build for the first seed; defer the rebuild to avoid setState-during-build.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() {});
      });
    }
  }

  void _cycle(String studentId) {
    final current = _draft[studentId] ?? AttendanceMark.present(studentId);
    setState(() => _draft[studentId] = current.cycled());
  }

  void _setMinutesLate(String studentId, int minutes) {
    final current = _draft[studentId];
    if (current == null) return;
    setState(() => _draft[studentId] = current.withMinutesLate(minutes));
  }

  Future<void> _submit(AttendanceTakingRegister register) async {
    if (_submitting) return;

    final marks = <QueuedMark>[];
    for (final enrolment in register.editableRoster) {
      final mark = _draft[enrolment.studentId] ?? AttendanceMark.present(enrolment.studentId);
      marks.add(
        QueuedMark(
          studentId: mark.studentId,
          status: mark.status.wireStatus,
          minutesLate: mark.status == AttendanceMarkStatus.late ? mark.minutesLate : null,
        ),
      );
    }
    if (marks.isEmpty) return;

    final submission = QueuedAttendanceSubmission(
      classId: widget.classId,
      sessionDate: _today(),
      period: widget.period,
      records: marks,
      queuedAt: DateTime.now(),
    );

    setState(() => _submitting = true);
    final queue = ref.read(attendanceSyncQueueProvider);

    try {
      // Persist before the first network attempt so a mid-send crash still replays.
      await queue.enqueue(submission);
      final outcome = await queue.flushOne(submission);
      if (!mounted) return;

      switch (outcome) {
        case AttendanceRecorded():
          setState(() => _deferred = false);
          ref.invalidate(attendanceRegisterProvider(_scope));
          _snack('teacher.attendance.submitSuccess');
        case AttendanceSyncDeferred():
          setState(() => _deferred = true);
          _snack('teacher.attendance.savedOffline');
        case AttendanceSyncRejected(:final code, :final message):
          _showRejection(code, message);
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // --- Recorded -----------------------------------------------------------

  Widget _buildRecorded(RecordedRegister register) {
    return Column(
      children: [
        _ScopeHeader(period: widget.period),
        Container(
          width: double.infinity,
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          padding: const EdgeInsets.all(AppSpacing.space12),
          child: Text(
            (register.canCorrect
                    ? 'teacher.attendance.recordedBanner'
                    : 'teacher.attendance.recordedElsewhere')
                .tr(),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
        Expanded(
          child: register.canCorrect
              ? ListView(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space16),
                  children: [
                    for (final record in register.records!)
                      _RecordedRow(
                        record: record,
                        onTap: () => _openCorrection(record),
                      ),
                  ],
                )
              : const _CenteredMessage(
                  icon: Icons.check_circle_outline,
                  messageKey: 'teacher.attendance.recordedNoDetail',
                ),
        ),
      ],
    );
  }

  Future<void> _openCorrection(AttendanceRecord record) async {
    final name = ref.read(rosterStudentNameProvider(record.studentId));
    final label = name ??
        'teacher.class.unknownStudent'.tr(
          namedArgs: {'id': _shortId(record.studentId)},
        );

    final saved = await AttendanceCorrectionSheet.show(
      context,
      record: record,
      studentLabel: label,
      scope: _scope,
    );
    if (saved == true && mounted) _snack('teacher.attendance.correction.saved');
  }

  // --- Sync -------------------------------------------------------------

  Future<void> _replayPending({bool announce = false}) async {
    final queue = ref.read(attendanceSyncQueueProvider);
    final report = await queue.flushAll();
    if (!mounted) return;

    if (report.changedAnything) {
      ref.invalidate(attendanceRegisterProvider(_scope));
    }
    for (final rejection in report.rejected) {
      _showRejection(rejection.code, rejection.message);
    }

    final stillPending =
        await queue.pendingFor(classId: widget.classId, period: widget.period);
    if (!mounted) return;
    setState(() => _deferred = stillPending != null);

    if (announce && stillPending != null) _snack('teacher.attendance.stillOffline');
  }

  // --- Helpers -------------------------------------------------------

  void _noop() {}

  void _snack(String messageKey) {
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(messageKey.tr())));
  }

  void _showRejection(String? code, String message) {
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('teacher.attendance.rejectedTitle'.tr()),
        content: Text(
          code == null
              ? message
              : 'teacher.attendance.rejectedBody'.tr(namedArgs: {'code': code}),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: Text(MaterialLocalizations.of(dialogContext).okButtonLabel),
          ),
        ],
      ),
    );
  }

  String _shortId(String id) => id.length <= 6 ? id : id.substring(id.length - 6);

  DateTime _today() {
    final now = DateTime.now();
    return DateTime(now.year, now.month, now.day);
  }
}

/// The period / date line under the app bar.
class _ScopeHeader extends StatelessWidget {
  const _ScopeHeader({required this.period});

  final int? period;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final date = DateFormat.yMMMEd(context.locale.toString()).format(DateTime.now());
    final scope = period == null
        ? 'teacher.attendance.dailyScope'.tr()
        : 'teacher.home.sessions.period'.tr(namedArgs: {'period': '$period'});

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space16,
        AppSpacing.space12,
        AppSpacing.space16,
        AppSpacing.space4,
      ),
      child: Text(
        '$scope · $date',
        style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
      ),
    );
  }
}

/// A student already written to an open session — the batch endpoint would skip them on
/// resubmit, so they are shown read-only until the session is submitted and they become
/// correctable.
class _LockedRow extends ConsumerWidget {
  const _LockedRow({required this.record});

  final AttendanceRecord record;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(rosterStudentNameProvider(record.studentId));
    final title = name ??
        'teacher.class.unknownStudent'.tr(
          namedArgs: {
            'id': record.studentId.length <= 6
                ? record.studentId
                : record.studentId.substring(record.studentId.length - 6),
          },
        );

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.space12, horizontal: AppSpacing.space4),
      child: Row(
        children: [
          Icon(Icons.lock_outline, size: 16, color: Theme.of(context).colorScheme.onSurfaceVariant),
          const SizedBox(width: AppSpacing.space12),
          Expanded(
            child: Text(title, style: Theme.of(context).textTheme.bodyMedium, maxLines: 1),
          ),
          AttendanceStatusPill(status: record.status),
        ],
      ),
    );
  }
}

class _RecordedRow extends ConsumerWidget {
  const _RecordedRow({required this.record, required this.onTap});

  final AttendanceRecord record;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final name = ref.watch(rosterStudentNameProvider(record.studentId));
    final title = name ??
        'teacher.class.unknownStudent'.tr(
          namedArgs: {
            'id': record.studentId.length <= 6
                ? record.studentId
                : record.studentId.substring(record.studentId.length - 6),
          },
        );

    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          vertical: AppSpacing.space12,
          horizontal: AppSpacing.space4,
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: theme.textTheme.bodyMedium, maxLines: 1),
                  if (record.minutesLate != null)
                    Text(
                      'attendance.lateBy'.tr(namedArgs: {'minutes': '${record.minutesLate}'}),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.space8),
            AttendanceStatusPill(status: record.status),
            const SizedBox(width: AppSpacing.space4),
            Icon(Icons.chevron_right, size: 18, color: theme.colorScheme.onSurfaceVariant),
          ],
        ),
      ),
    );
  }
}

class _CenteredMessage extends StatelessWidget {
  const _CenteredMessage({required this.icon, required this.messageKey});

  final IconData icon;
  final String messageKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 32, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              messageKey.tr(),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorRetry extends StatelessWidget {
  const _ErrorRetry({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 32, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(height: AppSpacing.space12),
            Text(
              'teacher.attendance.loadError'.tr(),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.space12),
            OutlinedButton(onPressed: onRetry, child: Text('teacher.attendance.retry'.tr())),
          ],
        ),
      ),
    );
  }
}
