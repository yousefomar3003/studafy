import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../config/app_config.dart';
import '../network/network_config.dart';
import '../router/app_router.dart';

final appConfigProvider = Provider<AppConfig>((ref) {
  throw StateError('AppConfig must be provided during app bootstrap.');
});

final networkConfigProvider = Provider<NetworkConfig>((ref) {
  final appConfig = ref.watch(appConfigProvider);

  return NetworkConfig(
    apiBaseUrl: appConfig.apiBaseUrl,
    realtimeBaseUrl: appConfig.realtimeBaseUrl,
  );
});

final routerProvider = Provider<GoRouter>((ref) {
  final appConfig = ref.watch(appConfigProvider);

  return createAppRouter(appConfig: appConfig);
});
