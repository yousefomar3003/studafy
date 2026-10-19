import 'dart:io';

import 'package:image_picker/image_picker.dart';
import 'package:mime/mime.dart';

import '../domain/draft_attachment.dart';

/// Picks images for a chat message — a seam over `image_picker` so widget tests can supply
/// images without the platform plugin.
///
/// Images are downscaled (longest edge [_maxDimension], quality [_quality]) when picked, which
/// keeps photos well under the 10 MiB limit and has iOS hand back JPEG rather than HEIC.
/// Camera permission errors surface as the plugin's `PlatformException`
/// (`camera_access_denied`).
class ChatImagePicker {
  ChatImagePicker([ImagePicker? picker]) : _picker = picker ?? ImagePicker();

  final ImagePicker _picker;

  static const double _maxDimension = 2560;
  static const int _quality = 85;

  /// Up to [limit] images from the photo library; empty when the user cancels.
  Future<List<PickedImage>> pickFromGallery({required int limit}) async {
    if (limit <= 0) return const [];
    final List<XFile> files;
    if (limit == 1) {
      // pickMultiImage rejects a limit below 2.
      final file = await _picker.pickImage(
        source: ImageSource.gallery,
        maxWidth: _maxDimension,
        maxHeight: _maxDimension,
        imageQuality: _quality,
      );
      files = [?file];
    } else {
      files = await _picker.pickMultiImage(
        limit: limit,
        maxWidth: _maxDimension,
        maxHeight: _maxDimension,
        imageQuality: _quality,
      );
    }
    return [for (final file in files.take(limit)) await _describe(file)];
  }

  /// One photo from the camera; null when the user cancels.
  Future<PickedImage?> takePhoto() async {
    final file = await _picker.pickImage(
      source: ImageSource.camera,
      maxWidth: _maxDimension,
      maxHeight: _maxDimension,
      imageQuality: _quality,
    );
    return file == null ? null : _describe(file);
  }

  Future<PickedImage> _describe(XFile file) async => PickedImage(
    path: file.path,
    fileName: file.name,
    contentType: normalizeImageContentType(file.mimeType ?? lookupMimeType(file.path)),
    sizeBytes: await File(file.path).length(),
  );
}
