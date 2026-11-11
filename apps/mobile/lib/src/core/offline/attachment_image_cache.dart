import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../auth/auth_providers.dart';
import '../auth/auth_state.dart';

/// On-device byte cache for pictures served through short-lived pre-signed URLs (chat
/// attachments, assignment question pictures), keyed by a stable id instead of the URL.
///
/// A pre-signed URL is re-minted on every list read, so a URL-keyed cache (`Image.network`'s
/// in-memory one) misses each time the list is re-fetched and downloads the same picture again —
/// on every chat poll that refreshes URLs, every reopen of an assignment, every app start. Keying
/// by the attachment id (immutable: a changed picture is a new attachment) downloads each picture
/// once per device.
///
/// Same rules as [MaterialFileCache] (`material_file_cache.dart`): filesystem existence is the
/// cache state; files live in the app's own private directory (here the cache directory, which
/// the OS may purge and does not back up — fine for bytes that can always be re-downloaded); and
/// everything is wiped on logout ([attachmentImageCacheProvider]). Callers only look a picture up
/// while the server still hands out a URL for it, so a picture the server stops serving (a
/// quarantined upload, a revoked share) is not shown from the cache either.
///
/// Every disk step is best-effort: when the directory is unavailable (no plugin in a widget test,
/// a full disk) the picture is simply downloaded as before.
class AttachmentImageCache {
  AttachmentImageCache({
    Future<Directory> Function()? root,
    Dio? dio,
    this.maxBytes = 100 * 1024 * 1024,
  }) : _root = root ?? getApplicationCacheDirectory,
       _dio = dio ?? Dio();

  final Future<Directory> Function() _root;
  final Dio _dio;

  /// Above this total the least recently used files are deleted (down to three quarters of it).
  final int maxBytes;

  /// How many writes pass between two size checks (the first write always checks).
  static const _pruneEvery = 20;

  final _inFlight = <String, Future<Uint8List>>{};
  final _pendingWrites = <Future<void>>{};
  int _writesSincePrune = _pruneEvery;

  /// Completes once every disk write (and any prune it triggered) started so far has finished.
  /// The writes are fire-and-forget so a picture shows before it is stored; tests wait on this
  /// instead of guessing a delay.
  @visibleForTesting
  Future<void> flush() => Future.wait(_pendingWrites.toList());

  Future<Directory> _dir() async {
    final root = await _root();
    return Directory(
      p.join(root.path, 'attachment_images'),
    ).create(recursive: true);
  }

  /// A file-system-safe name for [namespace] + [id] (ids are UUIDs; anything else is replaced).
  static String fileNameFor(String namespace, String id) =>
      '${namespace}_$id'.replaceAll(RegExp('[^A-Za-z0-9_-]'), '_');

  /// The picture's bytes: from disk when it was downloaded before, otherwise from [url] (then
  /// stored). Concurrent calls for the same picture share one download.
  Future<Uint8List> load(
    String namespace,
    String id,
    String url, {
    void Function(int received, int? total)? onProgress,
  }) {
    final name = fileNameFor(namespace, id);
    // A block body: `whenComplete` waits on a returned future, and `remove` returns this one.
    return _inFlight[name] ??= _load(name, url, onProgress).whenComplete(() {
      _inFlight.remove(name);
    });
  }

  Future<Uint8List> _load(
    String name,
    String url,
    void Function(int received, int? total)? onProgress,
  ) async {
    final cached = await _read(name);
    if (cached != null) return cached;

    final response = await _dio.get<List<int>>(
      url,
      options: Options(responseType: ResponseType.bytes),
      onReceiveProgress: onProgress == null
          ? null
          : (received, total) => onProgress(received, total > 0 ? total : null),
    );
    final data = response.data;
    if (data == null || data.isEmpty) throw StateError('Empty image response');
    final bytes = data is Uint8List ? data : Uint8List.fromList(data);
    final write = _write(name, bytes);
    _pendingWrites.add(write);
    unawaited(write.whenComplete(() => _pendingWrites.remove(write)));
    return bytes;
  }

  Future<Uint8List?> _read(String name) async {
    try {
      final file = File(p.join((await _dir()).path, name));
      if (!await file.exists()) return null;
      final bytes = await file.readAsBytes();
      if (bytes.isEmpty) return null;
      // Recency for the size cap; a failure here only makes the file look older.
      unawaited(file.setLastModified(DateTime.now()).catchError((Object _) {}));
      return bytes;
    } on Object {
      return null;
    }
  }

  Future<void> _write(String name, Uint8List bytes) async {
    try {
      final dir = await _dir();
      // Written aside and renamed, so a reader never sees half a file.
      final partial = File(p.join(dir.path, '$name.part'));
      await partial.writeAsBytes(bytes, flush: true);
      await partial.rename(p.join(dir.path, name));
      if (++_writesSincePrune >= _pruneEvery) {
        _writesSincePrune = 0;
        await _prune(dir);
      }
    } on Object {
      // Not cached; the next view downloads it again.
    }
  }

  Future<void> _prune(Directory dir) async {
    final files = <(File, FileStat)>[];
    var total = 0;
    await for (final entry in dir.list()) {
      if (entry is! File) continue;
      final stat = await entry.stat();
      files.add((entry, stat));
      total += stat.size;
    }
    if (total <= maxBytes) return;
    files.sort((a, b) => a.$2.modified.compareTo(b.$2.modified));
    final target = maxBytes * 3 ~/ 4;
    for (final (file, stat) in files) {
      if (total <= target) break;
      try {
        await file.delete();
        total -= stat.size;
      } on Object {
        // Already gone, or in use; the next prune tries again.
      }
    }
  }

  /// Wipes every cached picture. Called on logout — see [attachmentImageCacheProvider].
  Future<void> clear() async {
    try {
      final dir = await _dir();
      await dir.delete(recursive: true);
    } on Object {
      // Nothing cached, or no directory to clear.
    }
  }
}

/// Wipes itself the moment a session logs out, the same rule [materialFileCacheProvider]
/// (`material_file_cache.dart`) follows: the pictures are school data and must not survive into a
/// different account signing in on the same device.
final attachmentImageCacheProvider = Provider<AttachmentImageCache>((ref) {
  final cache = AttachmentImageCache();
  ref.listen(authStatusProvider, (previous, next) {
    if (previous == AuthStatus.authenticated &&
        next == AuthStatus.unauthenticated) {
      cache.clear();
    }
  });
  return cache;
});

/// An [ImageProvider] for a picture behind a pre-signed [url], cached by [namespace] + [id] in
/// [cache] — on disk, and in Flutter's in-memory [ImageCache] under the same id, so a re-minted
/// [url] for an already shown picture neither downloads nor decodes it again.
///
/// [url] is deliberately not part of equality. A load that fails is evicted from the in-memory
/// cache, so a widget that wants to retry with a fresh URL (`ValueKey(url)` on the [Image]) gets a
/// new load rather than the failed one.
///
/// [cacheWidth], when set, decodes at that width (never upscaling), like [ResizeImage]; it is part
/// of the key, as it is for [ResizeImage].
@immutable
class AttachmentImageProvider extends ImageProvider<AttachmentImageProvider> {
  const AttachmentImageProvider({
    required this.cache,
    required this.namespace,
    required this.id,
    required this.url,
    this.cacheWidth,
  });

  final AttachmentImageCache cache;
  final String namespace;
  final String id;
  final String url;
  final int? cacheWidth;

  @override
  Future<AttachmentImageProvider> obtainKey(ImageConfiguration configuration) =>
      SynchronousFuture<AttachmentImageProvider>(this);

  @override
  ImageStreamCompleter loadImage(
    AttachmentImageProvider key,
    ImageDecoderCallback decode,
  ) {
    final chunkEvents = StreamController<ImageChunkEvent>();
    return MultiFrameImageStreamCompleter(
      codec: _load(key, decode, chunkEvents),
      chunkEvents: chunkEvents.stream,
      scale: 1,
      debugLabel: '$namespace/$id',
      informationCollector: () => [
        DiagnosticsProperty<ImageProvider>('Image provider', this),
      ],
    );
  }

  Future<ui.Codec> _load(
    AttachmentImageProvider key,
    ImageDecoderCallback decode,
    StreamController<ImageChunkEvent> chunkEvents,
  ) async {
    try {
      final bytes = await cache.load(
        namespace,
        id,
        url,
        onProgress: (received, total) => chunkEvents.add(
          ImageChunkEvent(
            cumulativeBytesLoaded: received,
            expectedTotalBytes: total,
          ),
        ),
      );
      final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
      final width = cacheWidth;
      if (width == null) return await decode(buffer);
      return await decode(
        buffer,
        getTargetSize: (intrinsicWidth, intrinsicHeight) => ui.TargetImageSize(
          width: width < intrinsicWidth ? width : intrinsicWidth,
        ),
      );
    } catch (_) {
      // As NetworkImage does: the cache may not hold the key yet, so evict once it can.
      scheduleMicrotask(() => PaintingBinding.instance.imageCache.evict(key));
      rethrow;
    } finally {
      unawaited(chunkEvents.close());
    }
  }

  @override
  bool operator ==(Object other) =>
      other is AttachmentImageProvider &&
      other.namespace == namespace &&
      other.id == id &&
      other.cacheWidth == cacheWidth;

  @override
  int get hashCode => Object.hash(namespace, id, cacheWidth);

  @override
  String toString() =>
      '${objectRuntimeType(this, 'AttachmentImageProvider')}("$namespace/$id", cacheWidth: $cacheWidth)';
}
