import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../api/error_mapping_interceptor.dart';
import '../di/app_providers.dart';
import 'app_version.dart';
import 'release_config.dart';
import 'update_config_client.dart';
import 'update_status.dart';

/// Which platform's slice of the release config applies to this build. Overridable in tests.
final currentMobilePlatformProvider = Provider<MobilePlatform>((ref) {
  return defaultTargetPlatform == TargetPlatform.iOS
      ? MobilePlatform.ios
      : MobilePlatform.android;
});

/// [UpdateConfigClient] on its own bare [Dio] — same base URL as the rest of the app, but no
/// auth interceptor (the endpoint is public and runs before login). The shared
/// [ErrorMappingInterceptor] still normalises a non-2xx body into an [ApiException].
final updateConfigClientProvider = Provider<UpdateConfigClient>((ref) {
  final baseUrl = ref.watch(networkConfigProvider).apiBaseUrl;
  final dio = Dio(BaseOptions(baseUrl: baseUrl.toString()))
    ..interceptors.add(ErrorMappingInterceptor());
  return UpdateConfigClient(dio);
});

/// This build's own `x.y.z` version, from the platform package metadata.
final currentAppVersionProvider = FutureProvider<AppVersion>((ref) async {
  final info = await PackageInfo.fromPlatform();
  return AppVersion.parse(info.version);
});

/// The forced-update decision. `forcedUpdateGuard` redirects to the blocking screen while this is
/// [UpdateStatus.updateRequired]; every other value (including while it is still loading) lets the
/// app run normally.
///
/// Deliberately fail-open: any failure fetching the config, or a version that will not parse,
/// resolves to [UpdateStatus.upToDate]. A backend blip must never lock users out of an app that
/// is otherwise fine — the floor is a safety valve, not an availability dependency.
final updateStatusProvider = FutureProvider<UpdateStatus>((ref) async {
  try {
    final platform = ref.watch(currentMobilePlatformProvider);
    final current = await ref.watch(currentAppVersionProvider.future);
    final config = await ref.watch(updateConfigClientProvider).fetch();
    return evaluateUpdateStatus(
      current: current,
      release: config.forPlatform(platform),
    );
  } catch (_) {
    return UpdateStatus.upToDate;
  }
});
