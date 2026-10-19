import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/layout/bottom_inset_padding.dart';

void main() {
  const screen = Size(400, 800);
  const safeArea = 34.0;
  const barHeight = 100.0;

  /// A tab screen as the app shell hosts it: its own `Scaffold` with a FAB, under a body whose
  /// bottom padding is the floating bar's height while the view padding is the device safe area.
  Widget tab({required double padding}) => MediaQuery(
    data: const MediaQueryData(
      size: screen,
      viewPadding: EdgeInsets.only(bottom: safeArea),
    ).copyWith(padding: EdgeInsets.only(bottom: padding)),
    child: MaterialApp(
      home: Builder(
        builder: (context) => Scaffold(
          floatingActionButton: Padding(
            padding: EdgeInsets.only(bottom: context.bottomBarOverlap),
            child: FloatingActionButton(
              onPressed: () {},
              child: const Icon(Icons.add),
            ),
          ),
        ),
      ),
    ),
  );

  testWidgets('a tab FAB sits above the shell bar', (tester) async {
    tester.view.physicalSize = screen;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(tab(padding: barHeight));
    await tester.pumpAndSettle();

    final fab = tester.getRect(find.byType(FloatingActionButton));
    expect(fab.bottom, lessThanOrEqualTo(screen.height - barHeight));
  });

  testWidgets('outside the shell the FAB keeps its default position', (
    tester,
  ) async {
    tester.view.physicalSize = screen;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(tab(padding: safeArea));
    await tester.pumpAndSettle();

    final fab = tester.getRect(find.byType(FloatingActionButton));
    expect(fab.bottom, screen.height - safeArea - kFloatingActionButtonMargin);
  });
}
