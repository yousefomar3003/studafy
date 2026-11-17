import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/widgets/protected_screen.dart';

/// QA-084: grade and transcript screens can't be screenshotted or recorded on Android
/// (FLAG_SECURE), and are covered whenever the app leaves the foreground, so the OS app-switcher
/// snapshot never shows them.
void main() {
  late List<MethodCall> calls;

  setUp(() {
    calls = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      ProtectedScreen.channel,
      (call) async {
        calls.add(call);
        return null;
      },
    );
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(ProtectedScreen.channel, null),
  );

  List<Object?> secureArgs() => [
    for (final call in calls)
      if (call.method == 'setSecure') call.arguments,
  ];

  Widget app(Widget child) => MaterialApp(home: child);

  testWidgets('turns screen protection on while shown and off when gone', (tester) async {
    await tester.pumpWidget(app(const ProtectedScreen(child: Text('GPA 3.9'))));
    expect(secureArgs(), [true]);

    await tester.pumpWidget(app(const Text('home')));
    expect(secureArgs(), [true, false]);
  });

  testWidgets('stays protected until the last sensitive screen is gone', (tester) async {
    await tester.pumpWidget(
      app(
        const Column(
          children: [
            ProtectedScreen(child: Text('grades')),
            ProtectedScreen(child: Text('transcript')),
          ],
        ),
      ),
    );
    expect(secureArgs(), [true]);

    await tester.pumpWidget(app(const Column(children: [ProtectedScreen(child: Text('grades'))])));
    expect(secureArgs(), [true]);

    await tester.pumpWidget(app(const Text('home')));
    expect(secureArgs(), [true, false]);
  });

  testWidgets('covers the content when the app leaves the foreground', (tester) async {
    await tester.pumpWidget(app(const ProtectedScreen(child: Text('GPA 3.9'))));
    expect(find.byKey(ProtectedScreen.coverKey), findsNothing);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    expect(find.byKey(ProtectedScreen.coverKey), findsOneWidget);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(find.byKey(ProtectedScreen.coverKey), findsNothing);
  });

  testWidgets('a platform without the channel (iOS) still shows the screen', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      ProtectedScreen.channel,
      null,
    );

    await tester.pumpWidget(app(const ProtectedScreen(child: Text('GPA 3.9'))));
    await tester.pump();

    expect(find.text('GPA 3.9'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
