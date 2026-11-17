import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../core/api/auth_interceptor.dart';
import '../../../core/api/error_mapping_interceptor.dart';
import '../../../core/auth/auth_providers.dart';
import '../../../core/di/app_providers.dart';
import '../data/ai_photo_text_client.dart';
import '../data/ai_sources_client.dart';
import '../domain/ai_source.dart';
import 'ask_ai_providers.dart';

/// [AiSourcesClient] on its own [Dio], wired like `aiStudyClientProvider`: same base URL, bearer
/// token and [ErrorMappingInterceptor].
final aiSourcesClientProvider = Provider<AiSourcesClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final session = ref.watch(authSessionProvider);
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(AuthInterceptor(() => session.tokenProvider))
    ..interceptors.add(ErrorMappingInterceptor());
  return AiSourcesClient(dio);
});

/// How often a list re-reads while one of its sources is still being scanned or read. Tests set
/// it to [Duration.zero], which turns the re-read off.
final aiSourcePollIntervalProvider = Provider<Duration>((ref) => const Duration(seconds: 3));

void _pollWhile(Ref ref, bool inFlight) {
  final interval = ref.read(aiSourcePollIntervalProvider);
  if (!inFlight || interval == Duration.zero) return;
  final timer = Timer(interval, ref.invalidateSelf);
  ref.onDispose(timer.cancel);
}

/// The signed-in student's own files and photos, re-read while any is still on its way to ready.
final aiPersonalSourcesProvider = FutureProvider.autoDispose<AiPersonalSources>((ref) async {
  final studentId = ref.watch(askAiStudentIdProvider);
  if (studentId == null) {
    return const AiPersonalSources(sources: [], usage: AiSourceUsage.empty);
  }
  final sources = await ref.watch(aiSourcesClientProvider).list(studentId: studentId);
  _pollWhile(ref, sources.anyInFlight);
  return sources;
});

/// The signed-in student's assignments that can be used as a source, re-read while one being
/// built is on its way to ready.
final aiAssignmentSourcesProvider = FutureProvider.autoDispose<List<AiAssignmentSource>>((
  ref,
) async {
  final studentId = ref.watch(askAiStudentIdProvider);
  if (studentId == null) return const [];
  final assignments = await ref.watch(aiSourcesClientProvider).assignments(studentId: studentId);
  _pollWhile(ref, assignments.any((item) => item.sourceStatus?.inFlight ?? false));
  return assignments;
});

/// The file the student picked could not be used: the AI tools don't read its format.
class AiSourceUnsupportedFile implements Exception {
  const AiSourceUnsupportedFile();
}

/// Picks a file or a photo to upload as a source. An interface so widget tests substitute it
/// through [aiSourceFilePickerProvider].
abstract class AiSourceFilePicker {
  /// A PDF, Word, PowerPoint, JPEG or PNG file from the device; null when cancelled.
  Future<AiSourceFile?> pickDocument();

  /// A photo from the camera or the gallery, re-encoded to JPEG; null when cancelled.
  Future<AiSourceFile?> pickPhoto(ImageSource source);
}

/// The device's own pickers: the system file picker (filtered to the formats the AI tools read)
/// and image_picker, which hands capture to the system camera app and re-encodes the photo (HEIC
/// included) to a JPEG at the same size and quality as an Ask AI photo.
class DeviceAiSourceFilePicker implements AiSourceFilePicker {
  DeviceAiSourceFilePicker([ImagePicker? picker]) : _picker = picker ?? ImagePicker();

  final ImagePicker _picker;

  static const double _maxDimension = 2560;
  static const int _quality = 85;

  @override
  Future<AiSourceFile?> pickDocument() async {
    final file = await FilePicker.pickFile(
      type: FileType.custom,
      allowedExtensions: aiSourceContentTypes.keys.toList(),
    );
    final path = file?.path;
    if (file == null || path == null) return null;
    final contentType = aiSourceContentTypeFor(file.name);
    if (contentType == null) throw const AiSourceUnsupportedFile();
    return (
      path: path,
      name: file.name,
      sizeBytes: await File(path).length(),
      contentType: contentType,
    );
  }

  @override
  Future<AiSourceFile?> pickPhoto(ImageSource source) async {
    final file = await _picker.pickImage(
      source: source,
      maxWidth: _maxDimension,
      maxHeight: _maxDimension,
      imageQuality: _quality,
    );
    if (file == null) return null;
    final bytes = await file.readAsBytes();
    final format = AiPhotoFormat.of(bytes);
    if (format == null) throw const AiSourceUnsupportedFile();
    final extension = format == AiPhotoFormat.png ? 'png' : 'jpg';
    final dot = file.name.lastIndexOf('.');
    final base = dot > 0 ? file.name.substring(0, dot) : file.name;
    return (
      path: file.path,
      name: '$base.$extension',
      sizeBytes: bytes.length,
      contentType: format.contentType,
    );
  }
}

final aiSourceFilePickerProvider = Provider<AiSourceFilePicker>(
  (ref) => DeviceAiSourceFilePicker(),
);
