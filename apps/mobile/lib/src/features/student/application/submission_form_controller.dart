import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:mime/mime.dart';

import '../../../core/api/api_exception.dart';
import '../../../core/api/generated/models/confirm_submission_attachment_body.dart';
import '../../../core/api/generated/models/create_submission_body.dart';
import '../../../core/api/generated/models/create_submission_upload_url_body.dart';
import '../../../core/api/generated/submissions/submissions_client.dart';
import '../domain/pending_attachment.dart';

/// Why the most recent [SubmissionFormController.submit] call didn't finish cleanly. The
/// controller classifies the failure instead of carrying a message string, so the widget layer
/// picks the wording (and locale) — same separation [ApiException.code] uses over its prose
/// `title`/`detail`.
enum SubmissionSubmitError {
  /// The API rejected the hand-in with 409 — past due and the assignment doesn't allow late
  /// submissions.
  closed,

  /// The text/content step succeeded but one or more attachments are still [UploadStatus.failed]
  /// after this attempt. Retry the individual files, then submit again.
  attachmentsFailed,

  /// A connectivity problem (timeout, no route), not a rejection.
  network,

  /// Anything else.
  unknown,
}

/// Immutable snapshot of an in-progress hand-in.
class SubmissionFormState {
  const SubmissionFormState({
    this.content = '',
    this.attachments = const [],
    this.isSubmitting = false,
    this.submitError,
    this.didSubmit = false,
  });

  final String content;
  final List<PendingAttachment> attachments;
  final bool isSubmitting;
  final SubmissionSubmitError? submitError;

  /// True once `createSubmission` succeeded and every attachment reached
  /// [UploadStatus.uploaded] — the screen watches this to know when to pop.
  final bool didSubmit;

  bool get hasUploadInFlight => attachments.any(
    (a) => a.status == UploadStatus.uploading || a.status == UploadStatus.confirming,
  );

  bool get canSubmit => !isSubmitting && !hasUploadInFlight;

  SubmissionFormState copyWith({
    String? content,
    List<PendingAttachment>? attachments,
    bool? isSubmitting,
    SubmissionSubmitError? submitError,
    bool clearSubmitError = false,
    bool? didSubmit,
  }) {
    return SubmissionFormState(
      content: content ?? this.content,
      attachments: attachments ?? this.attachments,
      isSubmitting: isSubmitting ?? this.isSubmitting,
      submitError: clearSubmitError ? null : (submitError ?? this.submitError),
      didSubmit: didSubmit ?? this.didSubmit,
    );
  }
}

/// Drives one assignment's hand-in: the free-text answer plus zero or more file attachments,
/// each uploaded through the three-step `SubmissionsClient` hand-off (upload URL, PUT, confirm)
/// with per-file progress and retry.
///
/// A plain [ChangeNotifier] rather than a Riverpod provider: this state is owned by exactly one
/// screen for the duration of one hand-in and never read anywhere else, so it doesn't need
/// Riverpod's cross-widget sharing or caching — see `AuthNotifier` (`core/auth/auth_notifier.dart`)
/// for where this codebase does reach for a real provider instead, when state is actually shared.
///
/// Ordering matters here in a way that isn't obvious from the API surface alone:
/// `createSubmission` must complete *before* any attachment upload starts, and must not be
/// re-called once it has succeeded unless [content] actually changed. Attachments are stamped
/// with "the current attempt_number" at confirm time (see `SubmissionAttachment.attemptNumber`'s
/// doc comment) — uploading a file first and only then resubmitting the text would silently
/// stamp that file against the attempt resubmission is about to supersede.
class SubmissionFormController extends ChangeNotifier {
  // `client`'s field is `_client` (private, so it can't be named as an initializing formal —
  // that would require the parameter itself to be named `_client`, which callers outside this
  // library couldn't pass).
  SubmissionFormController({
    required SubmissionsClient client,
    required this.assignmentId,
    String initialContent = '',
    Dio? uploadDio,
  }) : _client = client, // ignore: prefer_initializing_formals
       _uploadDio = uploadDio ?? Dio(),
       _state = SubmissionFormState(content: initialContent);

  final SubmissionsClient _client;
  final String assignmentId;

  /// Bare Dio instance for the pre-signed PUT — deliberately not `apiClientProvider`'s: that Dio
  /// carries an auth interceptor and error mapping tuned for the Studafy API's own
  /// `application/problem+json` errors, neither of which apply to a direct object-storage PUT.
  final Dio _uploadDio;

  SubmissionFormState _state;
  SubmissionFormState get state => _state;

  /// Id of the submission `createSubmission` created or replaced, once that step has succeeded.
  /// Null until then — attachment uploads gate on this, not on [state].
  String? _submissionId;

  /// The [SubmissionFormState.content] value [_submissionId] was created for, so a second
  /// [submit] call with unchanged text can skip straight to uploading remaining attachments
  /// instead of bumping `attempt_number` again for no reason.
  String? _submittedContent;

  int _localIdSeq = 0;
  final Map<String, CancelToken> _cancelTokens = {};

  void _emit(SubmissionFormState next) {
    _state = next;
    notifyListeners();
  }

  void updateContent(String value) {
    _emit(_state.copyWith(content: value));
  }

  void addFiles(Iterable<PlatformFile> files) {
    final added = [
      for (final file in files)
        if (file.path != null)
          PendingAttachment(
            localId: 'local-${_localIdSeq++}',
            fileName: file.name,
            sizeBytes: file.size,
            filePath: file.path!,
            contentType: lookupMimeType(file.path!) ?? 'application/octet-stream',
          ),
    ];
    if (added.isEmpty) return;
    _emit(_state.copyWith(attachments: [..._state.attachments, ...added]));
  }

  /// Removes a not-yet-uploaded (or failed) attachment. Cancels its request first if one is
  /// still in flight.
  void removeAttachment(String localId) {
    _cancelTokens[localId]?.cancel();
    _emit(
      _state.copyWith(attachments: _state.attachments.where((a) => a.localId != localId).toList()),
    );
  }

  /// Re-runs the upload URL → PUT → confirm sequence for one failed attachment. Always requests
  /// a fresh upload URL rather than reusing the failed attempt's — pre-signed URLs are short-lived
  /// (see `SubmissionUploadUrl.expiresAt`) and the failure may be exactly that it expired.
  Future<void> retryAttachment(String localId) {
    final index = _state.attachments.indexWhere((a) => a.localId == localId);
    if (index == -1) return Future.value();
    final current = _state.attachments[index];
    if (current.status == UploadStatus.uploading || current.status == UploadStatus.confirming) {
      return Future.value();
    }
    return _uploadOne(localId);
  }

  Future<void> submit() async {
    if (!_state.canSubmit) return;
    _emit(_state.copyWith(isSubmitting: true, clearSubmitError: true));

    try {
      if (_submissionId == null || _submittedContent != _state.content) {
        final trimmed = _state.content.trim();
        final submission = await _client.createSubmission(
          assignmentId: assignmentId,
          body: CreateSubmissionBody(content: trimmed.isEmpty ? null : trimmed),
        );
        _submissionId = submission.id;
        _submittedContent = _state.content;
      }

      final pending = _state.attachments
          .where((a) => a.status != UploadStatus.uploaded)
          .map((a) => a.localId)
          .toList();
      await Future.wait(pending.map(_uploadOne));

      final stillFailed = _state.attachments.any((a) => a.status == UploadStatus.failed);
      _emit(
        _state.copyWith(
          isSubmitting: false,
          submitError: stillFailed ? SubmissionSubmitError.attachmentsFailed : null,
          clearSubmitError: !stillFailed,
          didSubmit: !stillFailed,
        ),
      );
    } on DioException catch (error) {
      _emit(_state.copyWith(isSubmitting: false, submitError: _classify(error)));
    } catch (_) {
      _emit(_state.copyWith(isSubmitting: false, submitError: SubmissionSubmitError.unknown));
    }
  }

  Future<void> _uploadOne(String localId) async {
    final index = _state.attachments.indexWhere((a) => a.localId == localId);
    if (index == -1) return;
    final attachment = _state.attachments[index];
    final submissionId = _submissionId;
    if (submissionId == null) return;

    _updateAttachment(localId, (a) => a.copyWith(status: UploadStatus.uploading, progress: 0));

    final cancelToken = CancelToken();
    _cancelTokens[localId] = cancelToken;

    try {
      final uploadUrl = await _client.createSubmissionAttachmentUploadUrl(
        submissionId: submissionId,
        body: CreateSubmissionUploadUrlBody(
          fileName: attachment.fileName,
          contentType: attachment.contentType,
        ),
      );

      final file = File(attachment.filePath);
      final length = await file.length();

      await _uploadDio.put<void>(
        uploadUrl.uploadUrl,
        data: file.openRead(),
        cancelToken: cancelToken,
        options: Options(
          contentType: attachment.contentType,
          headers: {Headers.contentLengthHeader: length},
        ),
        onSendProgress: (sent, total) {
          _updateAttachment(localId, (a) => a.copyWith(progress: total > 0 ? sent / total : 0));
        },
      );

      _updateAttachment(localId, (a) => a.copyWith(status: UploadStatus.confirming, progress: 1));

      final confirmed = await _client.confirmSubmissionAttachment(
        submissionId: submissionId,
        body: ConfirmSubmissionAttachmentBody(
          storageKey: uploadUrl.storageKey,
          contentType: attachment.contentType,
        ),
      );

      _updateAttachment(
        localId,
        (a) => a.copyWith(status: UploadStatus.uploaded, attachmentId: confirmed.id),
      );
    } on DioException catch (error) {
      if (CancelToken.isCancel(error)) return;
      _updateAttachment(
        localId,
        (a) =>
            a.copyWith(status: UploadStatus.failed, error: error.apiError?.title ?? error.message),
      );
    } finally {
      _cancelTokens.remove(localId);
    }
  }

  void _updateAttachment(String localId, PendingAttachment Function(PendingAttachment) update) {
    _emit(
      _state.copyWith(
        attachments: [
          for (final a in _state.attachments)
            if (a.localId == localId) update(a) else a,
        ],
      ),
    );
  }

  SubmissionSubmitError _classify(DioException error) {
    if (error.apiError?.status == 409) return SubmissionSubmitError.closed;
    switch (error.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.connectionError:
        return SubmissionSubmitError.network;
      default:
        return SubmissionSubmitError.unknown;
    }
  }

  @override
  void dispose() {
    for (final token in _cancelTokens.values) {
      token.cancel();
    }
    super.dispose();
  }
}
