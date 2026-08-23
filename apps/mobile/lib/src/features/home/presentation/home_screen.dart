import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/app_providers.dart';
import '../../../design/widgets/app_info_tile.dart';

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final appConfig = ref.watch(appConfigProvider);
    final networkConfig = ref.watch(networkConfigProvider);
    final textTheme = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(title: const Text('Studafy')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Mobile shell', style: textTheme.headlineSmall),
                  const SizedBox(height: 8),
                  Text(
                    'Router, Riverpod, flavor config, and lightweight dependency injection are ready.',
                    style: textTheme.bodyMedium,
                  ),
                  const SizedBox(height: 24),
                  AppInfoTile(
                    label: 'Environment',
                    value: appConfig.environment.label,
                  ),
                  const SizedBox(height: 12),
                  AppInfoTile(
                    label: 'API base URL',
                    value: networkConfig.apiBaseUrl.toString(),
                  ),
                  const SizedBox(height: 12),
                  const AppInfoTile(label: 'Route', value: '/'),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
