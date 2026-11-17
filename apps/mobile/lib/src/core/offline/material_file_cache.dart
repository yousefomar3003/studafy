import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../auth/auth_providers.dart';
import '../auth/auth_state.dart';

/// On-device byte cache for downloaded material files, keyed by material id.
///
/// Filesystem existence *is* the cache state — there is no database row tracking it — so
/// "downloaded" and "not downloaded" (`materials_providers.dart`'s `materialDownloadedProvider`)
/// can never drift from what's actually on disk. The extension is recovered by listing the cache
/// directory rather than being passed back in at lookup time, so a caller asking "is this
/// downloaded?" never needs to know the material's file name — only its id.
///
/// Scoped under the app's own cache directory, never a shared or public location: a material's
/// bytes are school data, subject to the same "must not survive a different account signing in on
/// this device" rule [OfflineDatabase] (`offline_providers.dart`) follows — see
/// [materialFileCacheProvider]'s logout listener. The cache directory is left out of Android
/// backups and device transfer and out of iCloud backups (QA-080); the OS may purge it under
/// storage pressure, which only means a material is downloaded again.
class MaterialFileCache {
  const MaterialFileCache({this._root});

  final Future<Directory> Function()? _root;

  Future<Directory> _rootDir() => (_root ?? getApplicationCacheDirectory)();

  // Async filesystem calls throughout: every row of the materials list runs [find], so blocking
  // `*Sync` calls here stall the UI isolate once per row.
  Future<Directory> _materialsDir() async {
    final root = await _rootDir();
    return Directory(p.join(root.path, 'materials')).create(recursive: true);
  }

  /// The cached file for [materialId], or null if it hasn't been downloaded (or was cleared).
  Future<File?> find(String materialId) async {
    final root = await _rootDir();
    final dir = Directory(p.join(root.path, 'materials'));
    if (!await dir.exists()) return null;
    await for (final entry in dir.list()) {
      if (entry is File && p.basenameWithoutExtension(entry.path) == materialId) {
        return entry;
      }
    }
    return null;
  }

  /// Writes [bytes] to the on-device cache for [materialId], named after [originalFileName]'s
  /// extension, and returns the resulting file.
  Future<File> save(String materialId, String originalFileName, Uint8List bytes) async {
    final dir = await _materialsDir();
    final extension = p.extension(originalFileName);
    final file = File(p.join(dir.path, '$materialId$extension'));
    return file.writeAsBytes(bytes, flush: true);
  }

  /// Wipes every cached material file. Called on logout — see [materialFileCacheProvider].
  Future<void> clear() async {
    final dir = await _materialsDir();
    await dir.delete(recursive: true);
  }
}

/// The directory downloaded school files (materials, attachment pictures) are kept under: the OS
/// cache directory, which backups never copy (QA-080). Tests point it at a temporary directory.
final offlineFilesRootProvider = Provider<Future<Directory> Function()>(
  (ref) => getApplicationCacheDirectory,
);

/// A bare [Dio] used only to fetch pre-signed download bytes.
///
/// Deliberately not `apiClientProvider`'s (`core/auth/auth_providers.dart`): the pre-signed URL
/// points at object storage, not the Studafy API, so it needs neither the `Authorization` header
/// (the signature in the URL query string is the capability) nor `ErrorMappingInterceptor` (a
/// storage-bucket error response is provider-specific XML/JSON, not this API's `problem+json`
/// shape).
final materialBytesDioProvider = Provider<Dio>((ref) => Dio());

/// Wipes itself the moment a session logs out or the account switches, the same rule
/// [OfflineDatabase]'s own provider (`offline_providers.dart`) follows: a downloaded material's
/// bytes are school data and must not survive into a different account signing in on the same
/// device.
final materialFileCacheProvider = Provider<MaterialFileCache>((ref) {
  final cache = MaterialFileCache(root: ref.watch(offlineFilesRootProvider));
  ref.listen(authStatusProvider, (previous, next) {
    // Any exit from `authenticated`, not only to `unauthenticated` (QA-081): logging out with
    // another account on the phone, and switching accounts, go authenticated → loading →
    // authenticated. The same condition as `offlineDatabaseProvider`.
    if (previous == AuthStatus.authenticated && next != AuthStatus.authenticated) {
      unawaited(cache.clear());
    }
  });
  return cache;
});
