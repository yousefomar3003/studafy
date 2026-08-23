import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';

/// A fixed gallery of the themed components the acceptance criteria calls out — buttons,
/// inputs, cards, chips — under one [ThemeData], so a single golden captures whether the
/// component themes in `design/theme/component_themes/` still match Corporate Precision.
class _ThemeGallery extends StatelessWidget {
  const _ThemeGallery({required this.theme});

  final ThemeData theme;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: theme,
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FilledButton(onPressed: () {}, child: const Text('Primary action')),
              const SizedBox(height: 12),
              OutlinedButton(onPressed: () {}, child: const Text('Secondary action')),
              const SizedBox(height: 12),
              TextButton(onPressed: () {}, child: const Text('Tertiary action')),
              const SizedBox(height: 16),
              const TextField(
                decoration: InputDecoration(
                  labelText: 'Email address',
                  hintText: 'you@studafy.com',
                ),
              ),
              const SizedBox(height: 16),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Builder(
                    builder: (context) {
                      final textTheme = Theme.of(context).textTheme;
                      return Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('Card title', style: textTheme.titleMedium),
                          const SizedBox(height: 8),
                          Text(
                            'Cards use a hairline border at a 12px radius.',
                            style: textTheme.bodyMedium,
                          ),
                        ],
                      );
                    },
                  ),
                ),
              ),
              const SizedBox(height: 16),
              const Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  Chip(label: Text('Design')),
                  Chip(label: Text('Mobile')),
                  Chip(label: Text('Corporate Precision')),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

Future<void> _pumpGallery(WidgetTester tester, ThemeData theme) async {
  // A fixed surface makes the golden reproducible across machines regardless of the host's
  // default test window size or pixel ratio, and pins the text scale to 1x — accessibility
  // scaling itself is covered separately in app_theme_text_scale_test.dart, not by the golden.
  tester.view.physicalSize = const Size(420, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(
    MediaQuery(
      data: const MediaQueryData(textScaler: TextScaler.noScaling),
      child: _ThemeGallery(theme: theme),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('light theme component gallery', (tester) async {
    await _pumpGallery(tester, AppTheme.light);
    await expectLater(
      find.byType(_ThemeGallery),
      matchesGoldenFile('goldens/theme_gallery_light.png'),
    );
  });

  testWidgets('dark theme component gallery', (tester) async {
    await _pumpGallery(tester, AppTheme.dark);
    await expectLater(
      find.byType(_ThemeGallery),
      matchesGoldenFile('goldens/theme_gallery_dark.png'),
    );
  });
}
