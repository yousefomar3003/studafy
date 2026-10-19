import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/messaging/domain/draft_attachment.dart';

PickedImage _image({String? type = 'image/jpeg', int size = 1024}) =>
    PickedImage(
      path: '/tmp/a.jpg',
      fileName: 'a.jpg',
      contentType: type,
      sizeBytes: size,
    );

void main() {
  test('accepts JPEG, PNG, WebP and HEIC up to 10 MiB', () {
    for (final type in [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
    ]) {
      expect(validatePickedImage(_image(type: type)), isNull, reason: type);
    }
    expect(validatePickedImage(_image(size: 10 * 1024 * 1024)), isNull);
  });

  test('rejects other types, unknown types and oversized or empty files', () {
    expect(
      validatePickedImage(_image(type: 'image/gif')),
      AttachmentRejection.unsupportedType,
    );
    expect(
      validatePickedImage(_image(type: null)),
      AttachmentRejection.unsupportedType,
    );
    expect(
      validatePickedImage(_image(size: 10 * 1024 * 1024 + 1)),
      AttachmentRejection.tooLarge,
    );
    expect(validatePickedImage(_image(size: 0)), AttachmentRejection.tooLarge);
  });

  test('normalizes image/jpg and casing', () {
    expect(normalizeImageContentType('image/jpg'), 'image/jpeg');
    expect(normalizeImageContentType('IMAGE/PNG'), 'image/png');
    expect(normalizeImageContentType(null), isNull);
  });
}
