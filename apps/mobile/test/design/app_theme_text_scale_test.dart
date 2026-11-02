import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';

Widget _scaledApp(TextScaler scaler) {
  return MediaQuery(
    data: MediaQueryData(textScaler: scaler),
    child: MaterialApp(
      theme: AppTheme.light,
      debugShowCheckedModeBanner: false,
      home: const Scaffold(
        body: SingleChildScrollView(
          padding: EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Card title', key: Key('title')),
              Text(
                'Body copy long enough to wrap across more than one line at larger text scales.',
                key: Key('body'),
              ),
              FilledButton(onPressed: null, child: Text('Primary action')),
            ],
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('AppTypography respects the platform text scale', (tester) async {
    await tester.pumpWidget(_scaledApp(TextScaler.noScaling));
    await tester.pumpAndSettle();
    final baseline = tester.getSize(find.byKey(const Key('title')));

    await tester.pumpWidget(_scaledApp(const TextScaler.linear(2)));
    await tester.pumpAndSettle();
    final scaled = tester.getSize(find.byKey(const Key('title')));

    // No FlutterError (e.g. a RenderFlex overflow) was thrown by either pump above — pumping
    // itself fails the test if one is. On top of that, assert the text actually grew instead
    // of silently clamping, which is what a hardcoded `textScaler: TextScaler.noScaling`
    // somewhere in the theme would produce.
    expect(scaled.height, greaterThan(baseline.height * 1.5));
  });

  testWidgets('a filled button label grows with an accessibility text scale', (tester) async {
    await tester.pumpWidget(_scaledApp(TextScaler.noScaling));
    await tester.pumpAndSettle();
    final baseline = tester.getSize(find.text('Primary action'));

    await tester.pumpWidget(_scaledApp(const TextScaler.linear(1.5)));
    await tester.pumpAndSettle();
    final scaled = tester.getSize(find.text('Primary action'));

    expect(scaled.width, greaterThan(baseline.width));
    expect(scaled.height, greaterThan(baseline.height));
  });
}
