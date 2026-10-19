import 'chat_state.dart';
import 'messaging.dart';

/// An image the user picked for the next message (from the gallery or camera), before it is
/// uploaded: local path, display name, declared type and size.
class PickedImage {
  const PickedImage({
    required this.path,
    required this.fileName,
    required this.contentType,
    required this.sizeBytes,
  });

  final String path;
  final String fileName;

  /// Normalized MIME type (`image/jpg` → `image/jpeg`), or null when it could not be told.
  final String? contentType;
  final int sizeBytes;
}

/// Why a picked image was not added to the draft.
enum AttachmentRejection { unsupportedType, tooLarge, tooMany }

/// Checks [image] against what the API accepts for a message attachment: a JPEG / PNG / WebP /
/// HEIC image of at most [maxMessageAttachmentBytes]. Null when it is fine.
AttachmentRejection? validatePickedImage(PickedImage image) {
  if (!messageAttachmentContentTypes.contains(image.contentType)) {
    return AttachmentRejection.unsupportedType;
  }
  if (image.sizeBytes <= 0 || image.sizeBytes > maxMessageAttachmentBytes) {
    return AttachmentRejection.tooLarge;
  }
  return null;
}

/// `image/jpg` (which some pickers report) as the canonical `image/jpeg`; lower-cased.
String? normalizeImageContentType(String? contentType) {
  final type = contentType?.toLowerCase();
  return type == 'image/jpg' ? 'image/jpeg' : type;
}

/// Where a draft image's upload is.
enum DraftUploadStatus { uploading, uploaded, failed }

/// One image attached to the message being composed, uploaded right after it was picked
/// (request-upload → PUT). [storageKey] is set once uploaded; [failure] while failed.
class DraftAttachment {
  const DraftAttachment({
    required this.localId,
    required this.image,
    required this.status,
    this.progress = 0,
    this.storageKey,
    this.failure,
  });

  final String localId;
  final PickedImage image;
  final DraftUploadStatus status;

  /// 0–1 while uploading.
  final double progress;
  final String? storageKey;
  final PendingFailure? failure;

  DraftAttachment copyWith({
    DraftUploadStatus? status,
    double? progress,
    String? storageKey,
    PendingFailure? failure,
  }) {
    final next = status ?? this.status;
    return DraftAttachment(
      localId: localId,
      image: image,
      status: next,
      progress: progress ?? this.progress,
      storageKey: storageKey ?? this.storageKey,
      failure: next == DraftUploadStatus.failed ? (failure ?? this.failure) : null,
    );
  }
}
