import 'dart:convert';
import 'dart:math' as math;

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/generated/attendance/attendance_client.dart';
import '../../../core/api/generated/models/attendance_record.dart';
import '../../../core/api/generated/models/attendance_session.dart';
import '../../../core/api/generated/models/attendance_session_status.dart';
import '../../../core/api/generated/models/batch_record_attendance_body.dart';
import '../../../core/api/generated/models/create_attendance_session_body.dart';
import '../../../core/api/generated/models/update_attendance_session_body.dart';
import '../../../core/api/generated/models/update_attendance_session_body_status.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/offline/offline_database.dart';
import '../../../core/offline/offline_providers.dart';
import '../domain/attendance_sync.dart';

/// Largest roster the `POST /records/batch` endpoint accepts in one call (`records: 1–50`). A
/// bigger class is sent as consecutive chunks — each chunk is independently idempotent.
const int _maxBatchSize = 50;

/// Outbox namespace for pending [QueuedAttendanceSubmission]s, keyed by their [queueKey].
const String _outboxResource = 'attendance_outbox';

/// Cache namespace for the recorded set of a submitted session, keyed by session id. Written
/// after a successful sync so the correction flow has real record ids to work with even on a
/// fresh app launch.
const String _recordsResource = 'attendance_records';

/// Why a flush left a submission in the outbox to try again later.
enum AttendanceDeferReason {
  /// No route to the server — the expected offline case.
  offline,

  /// The server answered, but with 5xx / 408 / 429. Also worth retrying.
  serverError,

  /// Something unclassified went wrong. Kept rather than dropped so attendance is never lost.
  unknown,
}

/// The result of flushing one queued register.
sealed class AttendanceSyncOutcome {
  const AttendanceSyncOutcome();
}

/// The register reached the server. [records] is the full recorded set for the session.
class AttendanceRecorded extends AttendanceSyncOutcome {
  const AttendanceRecorded({required this.sessionId, required this.records});

  final String sessionId;
  final List<AttendanceRecord> records;
}

/// Left in the outbox — a transient failure, safe to replay unchanged.
class AttendanceSyncDeferred extends AttendanceSyncOutcome {
  const AttendanceSyncDeferred(this.reason);

  final AttendanceDeferReason reason;
}

/// Dropped from the outbox — the server permanently rejected it (a 4xx that a retry can't fix).
/// The teacher has to see this and re-take.
class AttendanceSyncRejected extends AttendanceSyncOutcome {
  const AttendanceSyncRejected({required this.code, required this.message});

  /// The API's machine-readable error code, when it sent one.
  final String? code;
  final String message;
}

/// The tally from draining the whole outbox.
class AttendanceFlushReport {
  const AttendanceFlushReport({
    required this.recorded,
    required this.rejected,
    required this.deferred,
  });

  final int recorded;
  final List<AttendanceSyncRejected> rejected;

  /// True when a transient failure stopped the drain with entries still queued.
  final bool deferred;

  bool get changedAnything => recorded > 0 || rejected.isNotEmpty;
}

/// Persists batch attendance submissions locally and replays them against the API.
///
/// The screen always [enqueue]s before it tries to send, so a register survives the app being
/// killed mid-request; [flushOne] / [flushAll] then push queued entries and remove each one only
/// once the server has it. Idempotency is the server's (see [QueuedAttendanceSubmission]), so a
/// double-send is harmless.
class AttendanceSyncQueue {
  AttendanceSyncQueue({required OfflineDatabase database, required AttendanceClient client})
    : _database = database,
      _client = client;

  final OfflineDatabase _database;
  final AttendanceClient _client;

  // --- Outbox ----------------------------------------------------------------

  Future<void> enqueue(QueuedAttendanceSubmission submission) {
    return _database.write(
      resource: _outboxResource,
      cacheKey: submission.queueKey,
      payload: jsonEncode(submission.toJson()),
      fetchedAt: DateTime.now().toUtc(),
    );
  }

  /// Pending submissions, oldest first.
  Future<List<QueuedAttendanceSubmission>> pending() async {
    final rows = await _database.readAllForResource(_outboxResource);
    return [
      for (final row in rows)
        QueuedAttendanceSubmission.fromJson(jsonDecode(row.payload) as Map<String, Object?>),
    ];
  }

  Future<QueuedAttendanceSubmission?> pendingFor({
    required String classId,
    required int? period,
  }) async {
    for (final submission in await pending()) {
      if (submission.classId == classId && submission.period == period) return submission;
    }
    return null;
  }

  Future<void> _remove(String queueKey) =>
      _database.deleteEntry(resource: _outboxResource, cacheKey: queueKey);

  // --- Replay --------------------------------------------------------------

  /// Sends one queued register: open the session (idempotent), record every chunk (idempotent per
  /// student), then move the session to `submitted` so the records become correctable. Removes the
  /// entry from the outbox on success or permanent rejection; leaves it on a transient failure.
  Future<AttendanceSyncOutcome> flushOne(QueuedAttendanceSubmission submission) async {
    try {
      final session = await _client.openAttendanceSession(
        body: _DateOnlyCreateAttendanceSessionBody(
          classId: submission.classId,
          sessionDate: submission.sessionDate,
          period: submission.period,
        ),
      );

      switch (session.status) {
        case AttendanceSessionStatus.submitted:
        case AttendanceSessionStatus.locked:
          // A previous attempt already finished; nothing left to do but clear the outbox.
          await _remove(submission.queueKey);
          return AttendanceRecorded(
            sessionId: session.id,
            records: await cachedRecords(session.id) ?? const [],
          );
        case AttendanceSessionStatus.cancelled:
          await _remove(submission.queueKey);
          return const AttendanceSyncRejected(
            code: 'ATTENDANCE_SESSION_CANCELLED',
            message: 'This session was cancelled and can no longer take attendance.',
          );
        case AttendanceSessionStatus.draft:
        case AttendanceSessionStatus.open:
        case AttendanceSessionStatus.$unknown:
          break;
      }

      var recorded = const <AttendanceRecord>[];
      for (final chunk in _chunk(submission.records, _maxBatchSize)) {
        final response = await _client.recordAttendanceBatch(
          body: BatchRecordAttendanceBody(
            attendanceSessionId: session.id,
            records: [for (final mark in chunk) mark.toBatchItem()],
          ),
        );
        // Every chunk's response carries the session's full record set, so the last one is
        // authoritative.
        recorded = response.records;
      }

      await _transitionToSubmitted(session);
      await _cacheRecords(session.id, recorded);
      await _remove(submission.queueKey);
      return AttendanceRecorded(sessionId: session.id, records: recorded);
    } on DioException catch (error) {
      return _classifyFailure(submission, error);
    } catch (error) {
      await _bumpAttempt(submission, error.toString());
      return const AttendanceSyncDeferred(AttendanceDeferReason.unknown);
    }
  }

  /// Drains the outbox oldest-first. Stops at the first transient failure — the rest of the queue
  /// would hit the same wall — but steps past a permanent rejection so one bad entry can't wedge
  /// the queue forever.
  Future<AttendanceFlushReport> flushAll() async {
    var recorded = 0;
    final rejected = <AttendanceSyncRejected>[];

    for (final submission in await pending()) {
      final outcome = await flushOne(submission);
      switch (outcome) {
        case AttendanceRecorded():
          recorded++;
        case AttendanceSyncRejected():
          rejected.add(outcome);
        case AttendanceSyncDeferred():
          return AttendanceFlushReport(recorded: recorded, rejected: rejected, deferred: true);
      }
    }

    return AttendanceFlushReport(recorded: recorded, rejected: rejected, deferred: false);
  }

  Future<void> _transitionToSubmitted(AttendanceSession session) async {
    try {
      await _client.updateAttendanceSessionStatus(
        sessionId: session.id,
        body: const UpdateAttendanceSessionBody(status: UpdateAttendanceSessionBodyStatus.submitted),
      );
    } on DioException catch (error) {
      // A replay can race an earlier attempt that already submitted. A 409 whose session is now
      // past `open` means the transition is done, not failed.
      if (error.apiError?.status == 409) {
        final current = await _client.getAttendanceSession(sessionId: session.id);
        if (current.status == AttendanceSessionStatus.submitted ||
            current.status == AttendanceSessionStatus.locked) {
          return;
        }
      }
      rethrow;
    }
  }

  Future<AttendanceSyncOutcome> _classifyFailure(
    QueuedAttendanceSubmission submission,
    DioException error,
  ) async {
    final status = error.apiError?.status;
    final isPermanent =
        status != null && status >= 400 && status < 500 && status != 408 && status != 429;

    if (isPermanent) {
      await _remove(submission.queueKey);
      return AttendanceSyncRejected(
        code: error.apiError?.code,
        message: error.apiError?.title ?? 'The server rejected this attendance submission.',
      );
    }

    await _bumpAttempt(submission, error.apiError?.title ?? error.message);
    return AttendanceSyncDeferred(
      status == null ? AttendanceDeferReason.offline : AttendanceDeferReason.serverError,
    );
  }

  Future<void> _bumpAttempt(QueuedAttendanceSubmission submission, String? error) {
    return enqueue(submission.recordAttempt(error: error));
  }

  // --- Records cache -------------------------------------------------------

  Future<List<AttendanceRecord>?> cachedRecords(String sessionId) async {
    final row = await _database.read(resource: _recordsResource, cacheKey: sessionId);
    if (row == null) return null;
    return [
      for (final entry in jsonDecode(row.payload) as List<Object?>)
        AttendanceRecord.fromJson(entry! as Map<String, Object?>),
    ];
  }

  Future<void> _cacheRecords(String sessionId, List<AttendanceRecord> records) {
    return _database.write(
      resource: _recordsResource,
      cacheKey: sessionId,
      payload: jsonEncode([for (final record in records) record.toJson()]),
      fetchedAt: DateTime.now().toUtc(),
    );
  }

  /// Replaces one record in the session's cached set by id, so a correction is reflected without
  /// a refetch (the API has no "list records for a session" endpoint).
  Future<void> replaceCachedRecord(String sessionId, AttendanceRecord updated) async {
    final current = await cachedRecords(sessionId);
    if (current == null) return;
    await _cacheRecords(sessionId, [
      for (final record in current)
        if (record.id == updated.id) updated else record,
    ]);
  }
}

Iterable<List<T>> _chunk<T>(List<T> items, int size) sync* {
  for (var start = 0; start < items.length; start += size) {
    yield items.sublist(start, math.min(start + size, items.length));
  }
}

/// A [CreateAttendanceSessionBody] whose `session_date` serialises as a bare `YYYY-MM-DD`.
///
/// The generated model emits `DateTime.toIso8601String()` — a full date-time — which the API's
/// `session_date` body schema (`z.iso.date()`) rejects with 400. The retrofit client builds its
/// request from `body.toJson()`, so overriding that is enough.
class _DateOnlyCreateAttendanceSessionBody extends CreateAttendanceSessionBody {
  // Not super parameters: `sessionDate` can't be forwarded verbatim (its whole point is the
  // date-only re-serialisation), and Dart forbids mixing `super.x` formals with an explicit
  // super call.
  // ignore: use_super_parameters
  _DateOnlyCreateAttendanceSessionBody({
    required String classId,
    required DateTime sessionDate,
    int? period,
  }) : super(classId: classId, sessionDate: sessionDate, period: period);

  @override
  Map<String, Object?> toJson() => {
    'class_id': classId,
    'session_date':
        '${sessionDate.year.toString().padLeft(4, '0')}-'
        '${sessionDate.month.toString().padLeft(2, '0')}-'
        '${sessionDate.day.toString().padLeft(2, '0')}',
    if (period != null) 'period': period,
  };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

final attendanceSyncQueueProvider = Provider<AttendanceSyncQueue>((ref) {
  return AttendanceSyncQueue(
    database: ref.watch(offlineDatabaseProvider),
    client: ref.watch(apiClientProvider).attendance,
  );
});
