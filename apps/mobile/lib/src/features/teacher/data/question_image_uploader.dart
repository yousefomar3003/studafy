import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/authenticated_dio.dart';
import '../../messaging/domain/draft_attachment.dart' show PickedImage;

/// The picture types and size a question picture may be; mirrors the API's
/// `assignment.question_image` content class.
const questionImageContentTypes = {'image/jpeg', 'image/png', 'image/webp'};
const maxQuestionImageBytes = 10 * 1024 * 1024;

/// Stages a question picture for the question save: `POST /api/storage/uploads/request-upload`
/// for the `assignment.question_image` class, then a PUT of the bytes to the signed URL. Not
/// confirmed afterwards — saving the questions does that, in the same transaction.
///
/// Hand-written like the chat image upload: the generated storage client types `content_class`
/// with the download-class enum, which has no upload classes.
class QuestionImageUploader {
  QuestionImageUploader(this._dio, {Dio? uploadDio})
    : _uploadDio = uploadDio ?? Dio();

  final Dio _dio;

  /// No auth interceptor: the signed URL is the credential, and a bearer header would break it.
  final Dio _uploadDio;

  /// Returns the staged temp/ storage key to send as `image.upload_key`.
  Future<String> upload(PickedImage image) async {
    final response = await _dio.post<Map<String, Object?>>(
      '/api/storage/uploads/request-upload',
      data: {
        'content_class': 'assignment.question_image',
        'file_name': image.fileName,
        'content_type': image.contentType,
        'size_bytes': image.sizeBytes,
      },
    );
    final data = response.data!;
    final file = File(image.path);
    await _uploadDio.put<void>(
      data['upload_url']! as String,
      data: file.openRead(),
      options: Options(
        contentType: image.contentType,
        headers: {Headers.contentLengthHeader: await file.length()},
      ),
    );
    return data['storage_key']! as String;
  }
}

final questionImageUploaderProvider = Provider<QuestionImageUploader>((ref) {
  return QuestionImageUploader(authenticatedDio(ref));
});
