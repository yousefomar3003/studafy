import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:image_picker/image_picker.dart';

/// The text the server read from a photo, for the student to review before sending it as a
/// question.
class AiPhotoText {
  const AiPhotoText({required this.text, required this.truncated, required this.confidence});

  factory AiPhotoText.fromJson(Map<String, dynamic> json) => AiPhotoText(
    text: json['text'] as String? ?? '',
    truncated: json['truncated'] as bool? ?? false,
    confidence: (json['confidence'] as num?)?.toInt() ?? 0,
  );

  final String text;

  /// The photo held more text than a question allows; the rest was cut.
  final bool truncated;

  /// Mean per-word confidence, 0-100.
  final int confidence;

  /// Below this the recognized text is likely to have mistakes worth pointing out.
  static const lowConfidence = 60;

  bool get isLowConfidence => confidence < lowConfidence;
}

/// The photo formats `POST /api/ai/photo-text` reads, by their leading bytes.
enum AiPhotoFormat {
  jpeg('image/jpeg', [0xff, 0xd8, 0xff]),
  png('image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const AiPhotoFormat(this.contentType, this._signature);

  final String contentType;
  final List<int> _signature;

  static AiPhotoFormat? of(Uint8List bytes) {
    for (final format in values) {
      if (bytes.length >= format._signature.length &&
          Iterable<int>.generate(format._signature.length)
              .every((i) => bytes[i] == format._signature[i])) {
        return format;
      }
    }
    return null;
  }
}

/// Client for `POST /api/ai/photo-text`: sends the photo as the raw request body and returns the
/// text the server read from it. The photo is read in memory on the server and not stored.
///
/// Concrete rather than an interface, like `AskAiClient`; tests substitute it by
/// `implements AiPhotoTextClient` through `aiPhotoTextClientProvider`.
class AiPhotoTextClient {
  AiPhotoTextClient(this._dio);

  final Dio _dio;

  /// Throws an `ApiException` (via the error-mapping interceptor) for a refused photo:
  /// `AI_PHOTO_TOO_LARGE`, `AI_PHOTO_UNSUPPORTED_TYPE`, or the Ask AI feature's own refusals.
  Future<AiPhotoText> read(Uint8List bytes, AiPhotoFormat format) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '/api/ai/photo-text',
      data: Stream<List<int>>.value(bytes),
      options: Options(
        contentType: format.contentType,
        headers: {Headers.contentLengthHeader: bytes.length},
      ),
    );
    return AiPhotoText.fromJson(response.data ?? const {});
  }
}

/// Picks one photo for Ask AI from the camera or the library, downscaled and re-encoded the same
/// way the chat's photos are, so it stays well under the server's size limit. Null when the
/// student cancels.
class AiPhotoPicker {
  AiPhotoPicker([ImagePicker? picker]) : _picker = picker ?? ImagePicker();

  final ImagePicker _picker;

  static const double _maxDimension = 2560;
  static const int _quality = 85;

  Future<Uint8List?> pick(ImageSource source) async {
    final file = await _picker.pickImage(
      source: source,
      maxWidth: _maxDimension,
      maxHeight: _maxDimension,
      imageQuality: _quality,
    );
    return file?.readAsBytes();
  }
}
