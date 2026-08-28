/// Where one locally-picked file is in the three-step hand-off to
/// `SubmissionsClient` (get an upload URL, PUT the bytes, confirm) — see
/// `submission_form_controller.dart`.
enum UploadStatus {
  /// Picked, not yet sent.
  queued,

  /// The PUT to the pre-signed URL is in flight; [PendingAttachment.progress] tracks it.
  uploading,

  /// PUT finished; confirming the object with the API.
  confirming,

  /// Confirmed and attached to the submission.
  uploaded,

  /// The upload URL request, the PUT, or the confirm failed. [PendingAttachment.error] holds why;
  /// retrying restarts from the upload URL, since a failed attempt may have let the pre-signed URL
  /// expire.
  failed,
}

/// A file picked for the current submission attempt and its upload progress.
///
/// Immutable — [SubmissionFormController] replaces entries in its state rather than mutating one
/// in place, so widgets diff cleanly off `==`.
class PendingAttachment {
  const PendingAttachment({
    required this.localId,
    required this.fileName,
    required this.sizeBytes,
    required this.filePath,
    required this.contentType,
    this.status = UploadStatus.queued,
    this.progress = 0,
    this.error,
    this.attachmentId,
  });

  /// Client-generated id distinguishing queued files before any of them has a server-assigned
  /// attachment id.
  final String localId;

  final String fileName;
  final int sizeBytes;
  final String filePath;
  final String contentType;
  final UploadStatus status;

  /// Fraction of [sizeBytes] sent so far, `0`–`1`. Only meaningful while [status] is
  /// [UploadStatus.uploading].
  final double progress;

  /// Human-readable failure reason, set only when [status] is [UploadStatus.failed].
  final String? error;

  /// Set once [status] reaches [UploadStatus.uploaded].
  final String? attachmentId;

  bool get isTerminal => status == UploadStatus.uploaded;

  PendingAttachment copyWith({
    UploadStatus? status,
    double? progress,
    String? error,
    String? attachmentId,
  }) {
    return PendingAttachment(
      localId: localId,
      fileName: fileName,
      sizeBytes: sizeBytes,
      filePath: filePath,
      contentType: contentType,
      status: status ?? this.status,
      progress: progress ?? this.progress,
      // Explicit clear rather than `?? this.error`: a retry that transitions back to `uploading`
      // must drop the previous failure, not carry it forward.
      error: error,
      attachmentId: attachmentId ?? this.attachmentId,
    );
  }
}
