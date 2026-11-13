import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:studafy_mobile/src/features/launch/application/launch_intro.dart';
import 'package:studafy_mobile/src/features/launch/presentation/brand_splash.dart';
import 'package:studafy_mobile/src/features/launch/presentation/launch_gate.dart';
import 'package:studafy_mobile/src/features/launch/presentation/launch_guide.dart';

import '../../support/wrap_with_localization.dart';

/// The launch cover: the brand splash for a moment, the first-run guide when asked for, then the
/// app underneath.
void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  Future<void> pumpGate(WidgetTester tester, LaunchIntro intro) async {
    await tester.pumpWidget(
      wrapWithLocalization(
        ProviderScope(
          overrides: [launchIntroProvider.overrideWithValue(intro)],
          child: Builder(
            builder: (context) => MaterialApp(
              locale: context.locale,
              supportedLocales: context.supportedLocales,
              localizationsDelegates: context.localizationDelegates,
              builder: (context, child) => LaunchGate(child: child!),
              home: const Scaffold(body: Text('App home')),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  Future<void> finishSplash(WidgetTester tester) async {
    await tester.pump(LaunchGate.splashDuration);
    await tester.pumpAndSettle();
  }

  testWidgets('no intro opens the app straight away', (tester) async {
    await pumpGate(tester, LaunchIntro.none);

    expect(find.byType(BrandSplash), findsNothing);
    await tester.tap(find.text('App home'));
  });

  testWidgets('the splash covers the app, then lifts', (tester) async {
    await pumpGate(tester, LaunchIntro.splash);

    expect(find.byType(BrandSplash), findsOneWidget);
    expect(find.bySemanticsLabel('Studafy'), findsOneWidget);
    // Built underneath, but not reachable while covered.
    expect(find.text('App home').hitTestable(), findsNothing);

    await finishSplash(tester);

    expect(find.byType(BrandSplash), findsNothing);
    expect(find.byType(LaunchGuide), findsNothing);
    expect(find.text('App home').hitTestable(), findsOneWidget);
  });

  testWidgets('first launch: splash, then Next through the guide to the app', (
    tester,
  ) async {
    await pumpGate(tester, LaunchIntro.splashThenGuide);
    await finishSplash(tester);

    expect(find.byType(LaunchGuide), findsOneWidget);
    expect(find.text('Your whole school day, in one place'), findsOneWidget);

    await tester.tap(find.byKey(const Key('launchGuideNext')));
    await tester.pumpAndSettle();
    expect(find.text('Never miss what matters'), findsOneWidget);

    await tester.tap(find.byKey(const Key('launchGuideNext')));
    await tester.pumpAndSettle();
    expect(find.text('One phone for the whole family'), findsOneWidget);
    expect(find.text('Get started'), findsOneWidget);

    await tester.tap(find.byKey(const Key('launchGuideNext')));
    await tester.pumpAndSettle();

    expect(find.byType(LaunchGuide), findsNothing);
    expect(find.text('App home').hitTestable(), findsOneWidget);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('launch.guide_seen'), isTrue);
  });

  testWidgets('Skip leaves the guide from any page', (tester) async {
    await pumpGate(tester, LaunchIntro.splashThenGuide);
    await finishSplash(tester);

    await tester.tap(find.byKey(const Key('launchGuideSkip')));
    await tester.pumpAndSettle();

    expect(find.byType(LaunchGuide), findsNothing);
    expect(find.text('App home').hitTestable(), findsOneWidget);
  });

  testWidgets('the guide fits an iPad in landscape and a small phone', (
    tester,
  ) async {
    for (final size in const [
      Size(1366, 1024),
      Size(320, 568),
      Size(568, 320),
    ]) {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await pumpGate(tester, LaunchIntro.splashThenGuide);
      await finishSplash(tester);
      expect(find.byType(LaunchGuide), findsOneWidget);
      expect(tester.takeException(), isNull);
    }
  });

  group('resolveLaunchIntro', () {
    test('a new install with no session gets the guide', () async {
      expect(
        await resolveLaunchIntro(isAuthenticated: false),
        LaunchIntro.splashThenGuide,
      );
    });

    test('a signed-in member updating the app only sees the splash', () async {
      expect(
        await resolveLaunchIntro(isAuthenticated: true),
        LaunchIntro.splash,
      );
    });

    test('once the guide is seen, only the splash', () async {
      await markLaunchGuideSeen();
      expect(
        await resolveLaunchIntro(isAuthenticated: false),
        LaunchIntro.splash,
      );
    });
  });

  test('the wordmark is 62% of the width, capped for an iPad', () {
    expect(
      BrandSplash.wordmarkWidth(const Size(390, 844)),
      closeTo(241.8, 0.1),
    );
    expect(BrandSplash.wordmarkWidth(const Size(1024, 1366)), 420);
  });
}
