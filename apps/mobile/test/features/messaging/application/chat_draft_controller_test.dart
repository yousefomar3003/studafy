import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/messaging/application/chat_draft_controller.dart';
import 'package:studafy_mobile/src/features/messaging/application/messaging_providers.dart';
import 'package:studafy_mobile/src/features/messaging/domain/chat_state.dart';
import 'package:studafy_mobile/src/features/messaging/domain/draft_attachment.dart';

import '../support.dart';

PickedImage _image(
  String name, {
  String type = 'image/jpeg',
  int size = 2048,
}) => PickedImage(
  path: '/tmp/$name',
  fileName: name,
  contentType: type,
  sizeBytes: size,
);

(ProviderContainer, ChatDraftController) _draft(FakeMessagingClient client) {
  final container = ProviderContainer(
    overrides: [messagingClientProvider.overrideWithValue(client)],
  );
  addTearDown(container.dispose);
  container.listen(chatDraftControllerProvider('conv-1'), (_, _) {});
  return (
    container,
    container.read(chatDraftControllerProvider('conv-1').notifier),
  );
}

List<DraftAttachment> _state(ProviderContainer container) =>
    container.read(chatDraftControllerProvider('conv-1'));

void main() {
  test(
    'uploads each picked image (request-upload → PUT) and keeps its storage key',
    () async {
      final client = FakeMessagingClient();
      final (container, draft) = _draft(client);

      final rejections = draft.add([
        _image('a.jpg'),
        _image('b.png', type: 'image/png'),
      ]);
      expect(rejections, isEmpty);
      expect(
        _state(container).map((a) => a.status),
        everyElement(DraftUploadStatus.uploading),
      );

      await pumpEventQueue();

      expect(
        client.uploadRequests.map(
          (r) => (r.fileName, r.contentType, r.sizeBytes),
        ),
        [('a.jpg', 'image/jpeg', 2048), ('b.png', 'image/png', 2048)],
      );
      expect(client.uploadedUrls, hasLength(2));
      expect(
        _state(container).map((a) => a.status),
        everyElement(DraftUploadStatus.uploaded),
      );
      expect(_state(container).map((a) => a.storageKey), ['key-0', 'key-1']);
    },
  );

  test(
    'shows progress while the PUT runs and blocks sending until it finishes',
    () async {
      final client = FakeMessagingClient()..uploadGate = Completer<void>();
      final (container, draft) = _draft(client);

      draft.add([_image('a.jpg')]);
      await pumpEventQueue();
      expect(_state(container).single.progress, 0.5);
      expect(draft.isUploading, isTrue);

      client.uploadGate!.complete();
      await pumpEventQueue();
      expect(draft.isUploading, isFalse);
      expect(_state(container).single.progress, 1);
    },
  );

  test('rejects bad types, oversized files and anything past four', () async {
    final client = FakeMessagingClient();
    final (container, draft) = _draft(client);

    final rejections = draft.add([
      _image('a.gif', type: 'image/gif'),
      _image('big.jpg', size: 11 * 1024 * 1024),
      for (var i = 0; i < 5; i++) _image('$i.jpg'),
    ]);

    expect(rejections, {
      AttachmentRejection.unsupportedType,
      AttachmentRejection.tooLarge,
      AttachmentRejection.tooMany,
    });
    expect(_state(container), hasLength(4));
    expect(draft.remaining, 0);
    await pumpEventQueue();
  });

  test(
    'a failed upload is marked with its reason and can be retried',
    () async {
      final client = FakeMessagingClient()
        ..uploadRequestError = apiError(402, 'STORAGE_QUOTA_EXCEEDED');
      final (container, draft) = _draft(client);

      draft.add([_image('a.jpg')]);
      await pumpEventQueue();
      final failed = _state(container).single;
      expect(failed.status, DraftUploadStatus.failed);
      expect(failed.failure, PendingFailure.quotaExceeded);

      client.uploadRequestError = null;
      await draft.retry(failed.localId);
      expect(_state(container).single.status, DraftUploadStatus.uploaded);
    },
  );

  test(
    'takeUploaded hands over the uploaded images and leaves failed ones',
    () async {
      final client = FakeMessagingClient();
      final (container, draft) = _draft(client);

      draft.add([_image('a.jpg')]);
      await pumpEventQueue();
      client.uploadRequestError = apiError(503, 'STORAGE_NOT_CONFIGURED');
      draft.add([_image('b.jpg')]);
      await pumpEventQueue();

      final taken = draft.takeUploaded();
      expect(taken.map((i) => (i.localPath, i.storageKey)), [
        ('/tmp/a.jpg', 'key-0'),
      ]);
      expect(
        _state(container).single.failure,
        PendingFailure.storageUnavailable,
      );
    },
  );

  test('remove drops an image, even mid-upload', () async {
    final client = FakeMessagingClient()..uploadGate = Completer<void>();
    final (container, draft) = _draft(client);

    draft.add([_image('a.jpg')]);
    await pumpEventQueue();
    draft.remove(_state(container).single.localId);
    expect(_state(container), isEmpty);

    client.uploadGate!.complete();
    await pumpEventQueue();
    expect(_state(container), isEmpty);
  });
}
