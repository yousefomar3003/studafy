import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/chat_image_picker.dart';
import '../domain/chat_state.dart';
import '../domain/draft_attachment.dart';
import '../domain/messaging.dart';
import 'messaging_providers.dart';

/// The image picker the composer uses. Override in tests.
final chatImagePickerProvider = Provider<ChatImagePicker>((ref) => ChatImagePicker());

/// The images attached to the message being composed in one chat, keyed by conversation id.
///
/// Each picked image is validated (type, size, the four-per-message cap) and uploaded at once —
/// a pre-signed upload slot, then the PUT, with progress — so that by the time the user taps
/// send only the storage keys remain to go with the message. Removing an image cancels its
/// upload; a failed one can be retried (with a fresh upload slot). Auto-disposed with the chat,
/// cancelling anything still uploading.
class ChatDraftController extends Notifier<List<DraftAttachment>> {
  ChatDraftController(this.conversationId);

  final String conversationId;

  final Map<String, CancelToken> _cancelTokens = {};
  int _seq = 0;

  @override
  List<DraftAttachment> build() {
    ref.onDispose(() {
      for (final token in _cancelTokens.values) {
        token.cancel();
      }
      _cancelTokens.clear();
    });
    return const [];
  }

  /// How many more images the draft can take.
  int get remaining => maxMessageAttachments - state.length;

  /// Whether any image is still uploading — the message cannot be sent until none is.
  bool get isUploading => state.any((a) => a.status == DraftUploadStatus.uploading);

  /// The uploaded images, ready to go with the message.
  List<DraftAttachment> get uploaded => [
    for (final attachment in state)
      if (attachment.status == DraftUploadStatus.uploaded) attachment,
  ];

  /// Adds [images] (as many as still fit) and starts uploading each; returns why any were left
  /// out, one entry per kind.
  Set<AttachmentRejection> add(List<PickedImage> images) {
    final rejections = <AttachmentRejection>{};
    final accepted = <DraftAttachment>[];
    for (final image in images) {
      if (validatePickedImage(image) case final rejection?) {
        rejections.add(rejection);
        continue;
      }
      if (state.length + accepted.length >= maxMessageAttachments) {
        rejections.add(AttachmentRejection.tooMany);
        continue;
      }
      accepted.add(
        DraftAttachment(
          localId: 'draft-${_seq++}',
          image: image,
          status: DraftUploadStatus.uploading,
        ),
      );
    }
    if (accepted.isNotEmpty) {
      state = [...state, ...accepted];
      for (final attachment in accepted) {
        unawaited(_upload(attachment.localId));
      }
    }
    return rejections;
  }

  /// Removes one image, cancelling its upload if it is still running.
  void remove(String localId) {
    _cancelTokens.remove(localId)?.cancel();
    state = [
      for (final attachment in state)
        if (attachment.localId != localId) attachment,
    ];
  }

  /// Uploads a failed image again.
  Future<void> retry(String localId) async {
    final attachment = _byId(localId);
    if (attachment == null || attachment.status != DraftUploadStatus.failed) return;
    _update(localId, (a) => a.copyWith(status: DraftUploadStatus.uploading, progress: 0));
    await _upload(localId);
  }

  /// Takes the uploaded images out of the draft (for the message being sent), leaving any
  /// failed ones behind for a retry or removal.
  List<PendingImage> takeUploaded() {
    final taken = uploaded;
    final ids = {for (final attachment in taken) attachment.localId};
    state = [
      for (final attachment in state)
        if (!ids.contains(attachment.localId)) attachment,
    ];
    return [
      for (final attachment in taken)
        PendingImage(localPath: attachment.image.path, storageKey: attachment.storageKey!),
    ];
  }

  Future<void> _upload(String localId) async {
    final attachment = _byId(localId);
    if (attachment == null) return;
    final client = ref.read(messagingClientProvider);
    final cancelToken = CancelToken();
    _cancelTokens[localId] = cancelToken;
    try {
      final ticket = await client.requestAttachmentUpload(
        fileName: attachment.image.fileName,
        contentType: attachment.image.contentType!,
        sizeBytes: attachment.image.sizeBytes,
      );
      if (!ref.mounted || cancelToken.isCancelled) return;
      // Dio reports progress per chunk — many times a second — and each state change rebuilds the
      // chat screen, so only whole-percent steps are published.
      var lastPercent = -1;
      await client.uploadAttachment(
        uploadUrl: ticket.uploadUrl,
        file: File(attachment.image.path),
        contentType: attachment.image.contentType!,
        cancelToken: cancelToken,
        onProgress: (progress) {
          final percent = (progress * 100).floor();
          if (percent == lastPercent) return;
          lastPercent = percent;
          if (ref.mounted) _update(localId, (a) => a.copyWith(progress: progress));
        },
      );
      if (!ref.mounted || cancelToken.isCancelled) return;
      _update(
        localId,
        (a) => a.copyWith(
          status: DraftUploadStatus.uploaded,
          progress: 1,
          storageKey: ticket.storageKey,
        ),
      );
    } on Object catch (error) {
      if (!ref.mounted || cancelToken.isCancelled) return;
      if (error is DioException && CancelToken.isCancel(error)) return;
      _update(
        localId,
        (a) => a.copyWith(status: DraftUploadStatus.failed, failure: pendingFailureOf(error)),
      );
    } finally {
      if (_cancelTokens[localId] == cancelToken) _cancelTokens.remove(localId);
    }
  }

  DraftAttachment? _byId(String localId) {
    for (final attachment in state) {
      if (attachment.localId == localId) return attachment;
    }
    return null;
  }

  void _update(String localId, DraftAttachment Function(DraftAttachment) update) {
    state = [
      for (final attachment in state)
        if (attachment.localId == localId) update(attachment) else attachment,
    ];
  }
}

final chatDraftControllerProvider = NotifierProvider.autoDispose
    .family<ChatDraftController, List<DraftAttachment>, String>(ChatDraftController.new);
