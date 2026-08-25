import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/auth/auth_notifier.dart';
import 'core/auth/auth_state.dart';
import 'core/di/app_providers.dart';
import 'core/push/push_providers.dart';
import 'design/theme/app_theme.dart';

class StudafyApp extends ConsumerStatefulWidget {
  const StudafyApp({super.key});

  @override
  ConsumerState<StudafyApp> createState() => _StudafyAppState();
}

class _StudafyAppState extends ConsumerState<StudafyApp> {
  StreamSubscription<String>? _tapSub;
  bool _pushInitialized = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _subscribeToPushTaps();
    _initPushOnAuth();
  }

  @override
  void dispose() {
    _tapSub?.cancel();
    super.dispose();
  }

  /// Subscribe to notification taps for deep-link navigation.
  void _subscribeToPushTaps() {
    if (_tapSub != null) return;

    final pushService = ref.read(pushServiceProvider);
    _tapSub = pushService.onNotificationTap.listen((route) {
      if (!mounted) return;
      GoRouter.of(context).push(route);
    });
  }

  /// Initialize push when the user becomes authenticated.
  void _initPushOnAuth() {
    final status = ref.read(authStatusProvider);
    if (status == AuthStatus.authenticated && !_pushInitialized) {
      _pushInitialized = true;
      ref.read(pushInitProvider.notifier).initialize();
    }
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(routerProvider);

    return MaterialApp.router(
      debugShowCheckedModeBanner: false,
      title: 'Studafy',
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      routerConfig: router,
    );
  }
}
