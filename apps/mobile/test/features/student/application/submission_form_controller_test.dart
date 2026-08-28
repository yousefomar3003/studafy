import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/core/api/generated/models/confirm_submission_attachment_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/create_submission_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/create_submission_upload_url_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/grade_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/grade_submission_body.dart';
import 'package:studafy_mobile/src/core/api/generated/models/status13.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission_attachment.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission_grade_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission_list.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission_status.dart';
import 'package:studafy_mobile/src/core/api/generated/models/submission_upload_url.dart';
import 'package:studafy_mobile/src/core/api/generated/submissions/submissions_client.dart';
import 'package:studafy_mobile/src/features/student/application/submission_form_controller.dart';
import 'package:studafy_mobile/src/features/student/domain/pending_attachment.dart';

const _assignmentId = 'assignment-1';

Submission _fakeSubmission({required String id, int attemptNumber = 1}) {
  final now = DateTime(2026, 1, 1);
  return Submission(
    id: id,
    schoolId: 'school-1',
    assignmentId: _assignmentId,
    studentId: 'student-1',
    content: null,
    status: SubmissionStatus.submitted,
    gradeStatus: SubmissionGradeStatus.none,
    isLate: false,
    attemptNumber: attemptNumber,
    submittedAt: now,
    score: null,
    feedback: null,
    gradedAt: null,
    gradedByUserId: null,
    attachments: const [],
    lastEditedByUserId: 'student-1',
    createdAt: now,
    updatedAt: now,
  );
}

SubmissionAttachment _fakeAttachment(String id) {
  final now = DateTime(2026, 1, 1);
  return SubmissionAttachment(
    id: id,
    submissionId: 'submission-1',
    originalFileName: 'homework.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 12,
    checksumSha256: null,
    attemptNumber: 1,
    downloadUrl: 'https://storage.example/homework.pdf',
    downloadUrlExpiresAt: now.add(const Duration(minutes: 5)),
    uploadedByUserId: 'student-1',
    createdAt: now,
  );
}

/// Hand-written fake — same rationale as `_FakePublishedGradesClient`
/// (`today_grades_provider_test.dart`): [SubmissionsClient] is a thin Retrofit wrapper, and a
/// mocking library would only add ceremony over tracking a couple of call counts.
class _FakeSubmissionsClient implements SubmissionsClient {
  Object? createSubmissionError;
  int createSubmissionCalls = 0;
  int createUploadUrlCalls = 0;
  int confirmCalls = 0;
  String submissionId = 'submission-1';

  @override
  Future<Submission> createSubmission({
    required String assignmentId,
    required CreateSubmissionBody body,
  }) async {
    createSubmissionCalls++;
    final error = createSubmissionError;
    if (error != null) throw error;
    return _fakeSubmission(id: submissionId, attemptNumber: createSubmissionCalls);
  }

  @override
  Future<SubmissionUploadUrl> createSubmissionAttachmentUploadUrl({
    required String submissionId,
    required CreateSubmissionUploadUrlBody body,
  }) async {
    createUploadUrlCalls++;
    return SubmissionUploadUrl(
      uploadUrl: 'https://storage.example/upload/$createUploadUrlCalls',
      storageKey: 'staging/key-$createUploadUrlCalls',
      expiresAt: DateTime.now().add(const Duration(minutes: 5)),
    );
  }

  @override
  Future<SubmissionAttachment> confirmSubmissionAttachment({
    required String submissionId,
    required ConfirmSubmissionAttachmentBody body,
  }) async {
    confirmCalls++;
    return _fakeAttachment('attachment-$confirmCalls');
  }

  @override
  Future<Submission> getSubmission({required String submissionId}) => throw UnimplementedError();

  @override
  Future<Submission> gradeSubmission({
    required String submissionId,
    required GradeSubmissionBody body,
  }) => throw UnimplementedError();

  @override
  Future<SubmissionList> listSubmissions({
    required String assignmentId,
    Status13? status,
    GradeStatus? gradeStatus,
    String? studentId,
    int? limit,
    int? offset,
  }) => throw UnimplementedError();

  @override
  Future<void> deleteSubmissionAttachment({
    required String submissionId,
    required String attachmentId,
  }) => throw UnimplementedError();
}

/// A [HttpClientAdapter] standing in for real object storage: [behavior] decides the outcome per
/// PUT, and the request stream is always drained first so Dio's own progress-tracking transformer
/// (which wraps the stream before it reaches the adapter) still fires
/// [RequestOptions.onSendProgress] the same way it would against a real server.
class _FakeUploadAdapter implements HttpClientAdapter {
  _FakeUploadAdapter(this.behavior);

  final Future<ResponseBody> Function(RequestOptions options) behavior;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (requestStream != null) {
      await requestStream.drain<void>();
    }
    return behavior(options);
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody _ok() => ResponseBody.fromString('', 200);

File _tempFile(String content) {
  final file = File('${Directory.systemTemp.createTempSync('submission_test_').path}/homework.pdf');
  file.writeAsStringSync(content);
  addTearDown(() {
    if (file.existsSync()) file.deleteSync();
  });
  return file;
}

void main() {
  late _FakeSubmissionsClient client;

  setUp(() {
    client = _FakeSubmissionsClient();
  });

  SubmissionFormController buildController({
    Future<ResponseBody> Function(RequestOptions options)? uploadBehavior,
  }) {
    final dio = Dio()..httpClientAdapter = _FakeUploadAdapter(uploadBehavior ?? (_) async => _ok());
    return SubmissionFormController(client: client, assignmentId: _assignmentId, uploadDio: dio);
  }

  test('submitting text only calls createSubmission and marks didSubmit', () async {
    final controller = buildController();
    addTearDown(controller.dispose);

    controller.updateContent('My answer');
    await controller.submit();

    expect(client.createSubmissionCalls, 1);
    expect(controller.state.didSubmit, isTrue);
    expect(controller.state.submitError, isNull);
    expect(controller.state.isSubmitting, isFalse);
  });

  test(
    'submitting with one attachment uploads it through the full URL/PUT/confirm sequence',
    () async {
      final controller = buildController();
      addTearDown(controller.dispose);
      final file = _tempFile('pdf-bytes');

      controller.addFiles([PlatformFile(name: 'homework.pdf', size: 9, path: file.path)]);
      await controller.submit();

      expect(client.createSubmissionCalls, 1);
      expect(client.createUploadUrlCalls, 1);
      expect(client.confirmCalls, 1);
      expect(controller.state.didSubmit, isTrue);
      expect(controller.state.attachments.single.status, UploadStatus.uploaded);
      expect(controller.state.attachments.single.attachmentId, 'attachment-1');
    },
  );

  test('a failed upload marks the attachment failed without blocking the text hand-in', () async {
    final controller = buildController(
      uploadBehavior: (_) async => throw DioException(
        requestOptions: RequestOptions(path: '/upload'),
        type: DioExceptionType.connectionError,
      ),
    );
    addTearDown(controller.dispose);
    final file = _tempFile('pdf-bytes');

    controller.addFiles([PlatformFile(name: 'homework.pdf', size: 9, path: file.path)]);
    await controller.submit();

    // The text step still succeeded — only the attachment failed.
    expect(client.createSubmissionCalls, 1);
    expect(controller.state.attachments.single.status, UploadStatus.failed);
    expect(controller.state.submitError, SubmissionSubmitError.attachmentsFailed);
    expect(controller.state.didSubmit, isFalse);
  });

  test('retrying a failed attachment requests a fresh upload URL and can succeed', () async {
    var shouldFail = true;
    final controller = buildController(
      uploadBehavior: (_) async {
        if (shouldFail) {
          throw DioException(
            requestOptions: RequestOptions(path: '/upload'),
            type: DioExceptionType.connectionError,
          );
        }
        return _ok();
      },
    );
    addTearDown(controller.dispose);
    final file = _tempFile('pdf-bytes');

    controller.addFiles([PlatformFile(name: 'homework.pdf', size: 9, path: file.path)]);
    await controller.submit();
    expect(controller.state.attachments.single.status, UploadStatus.failed);
    expect(client.createUploadUrlCalls, 1);

    shouldFail = false;
    final localId = controller.state.attachments.single.localId;
    await controller.retryAttachment(localId);

    // A fresh upload URL was requested rather than reusing the failed attempt's.
    expect(client.createUploadUrlCalls, 2);
    expect(controller.state.attachments.single.status, UploadStatus.uploaded);

    // A second submit() with unchanged text must not bump attempt_number again — only the
    // (now-fixed) attachment set needs re-checking, and there's nothing left to upload.
    await controller.submit();
    expect(client.createSubmissionCalls, 1);
    expect(controller.state.didSubmit, isTrue);
  });

  test('a 409 from createSubmission classifies as closed', () async {
    client.createSubmissionError = DioException(
      requestOptions: RequestOptions(path: '/submissions'),
      error: const ApiException(status: 409, title: 'Past due'),
      type: DioExceptionType.badResponse,
    );
    final controller = buildController();
    addTearDown(controller.dispose);

    await controller.submit();

    expect(controller.state.submitError, SubmissionSubmitError.closed);
    expect(controller.state.didSubmit, isFalse);
  });

  test('removing a queued attachment drops it without contacting the server', () async {
    final controller = buildController();
    addTearDown(controller.dispose);
    final file = _tempFile('pdf-bytes');

    controller.addFiles([PlatformFile(name: 'homework.pdf', size: 9, path: file.path)]);
    final localId = controller.state.attachments.single.localId;
    controller.removeAttachment(localId);

    expect(controller.state.attachments, isEmpty);
    expect(client.createUploadUrlCalls, 0);
  });
}
