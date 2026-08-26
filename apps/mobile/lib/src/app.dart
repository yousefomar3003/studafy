import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/di/app_providers.dart';
import 'design/theme/app_theme.dart';

class StudafyApp extends ConsumerWidget {
  const StudafyApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);

    return MaterialApp.router(
      debugShowCheckedModeBanner: false,
      title: 'Studafy',
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      routerConfig: router,
      // Setting `locale` to an Arabic value is the entire RTL switch: `WidgetsApp` resolves
      // `Directionality` from the active locale via `GlobalWidgetsLocalizations`, so the tree
      // rebuilds right-to-left with no manual `Directionality` override anywhere below this.
      locale: context.locale,
      supportedLocales: context.supportedLocales,
      localizationsDelegates: context.localizationDelegates,
    );
  }
}
