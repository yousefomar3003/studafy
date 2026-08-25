import 'package:flutter/material.dart';

/// Temporary destination for notification deep-links.
///
/// Displays the route path so developers can verify the navigation wiring.
/// Replace with real feature screens once built.
class NotificationDestinationScreen extends StatelessWidget {
  const NotificationDestinationScreen({super.key, required this.route});

  final String route;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Scaffold(
      appBar: AppBar(title: const Text('Notification')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Deep link target', style: textTheme.headlineSmall),
                  const SizedBox(height: 8),
                  Text(
                    'This screen is a placeholder for the real destination.',
                    style: textTheme.bodyMedium,
                  ),
                  const SizedBox(height: 24),
                  SelectableText(
                    route,
                    style: textTheme.bodyLarge?.copyWith(
                      fontFamily: 'monospace',
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
