import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/widgets/keyboard_dismiss_scope.dart';

void main() {
  late FocusNode focusNode;
  late int buttonTaps;

  setUp(() {
    focusNode = FocusNode();
    buttonTaps = 0;
  });

  tearDown(() => focusNode.dispose());

  Future<void> pumpScope(WidgetTester tester) {
    return tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => KeyboardDismissScope(child: child!),
        home: Scaffold(
          body: Column(
            children: [
              TextField(
                key: const Key('field'),
                focusNode: focusNode,
                maxLines: 4,
              ),
              TextButton(
                onPressed: () => buttonTaps++,
                child: const Text('Tap me'),
              ),
              const Expanded(child: SizedBox.expand(key: Key('blank'))),
            ],
          ),
        ),
      ),
    );
  }

  testWidgets('tapping blank space closes the keyboard', (tester) async {
    await pumpScope(tester);
    await tester.tap(find.byKey(const Key('field')));
    await tester.pump();
    expect(focusNode.hasFocus, isTrue);

    await tester.tap(find.byKey(const Key('blank')));
    await tester.pump();
    expect(focusNode.hasFocus, isFalse);
  });

  testWidgets('a button still receives its own tap', (tester) async {
    await pumpScope(tester);
    await tester.tap(find.byKey(const Key('field')));
    await tester.pump();

    await tester.tap(find.text('Tap me'));
    await tester.pump();
    expect(buttonTaps, 1);
  });

  testWidgets('tapping the field itself keeps it focused', (tester) async {
    await pumpScope(tester);
    await tester.tap(find.byKey(const Key('field')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('field')));
    await tester.pump();
    expect(focusNode.hasFocus, isTrue);
  });

  testWidgets(
    'tapping a list tile closes the keyboard and the tile still gets its tap',
    (tester) async {
      var tileTaps = 0;
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => KeyboardDismissScope(child: child!),
          home: Scaffold(
            body: ListView(
              children: [
                TextField(key: const Key('field'), focusNode: focusNode),
                ListTile(title: const Text('Row'), onTap: () => tileTaps++),
              ],
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const Key('field')));
      await tester.pump();
      expect(focusNode.hasFocus, isTrue);

      await tester.tap(find.text('Row'));
      await tester.pump();
      expect(tileTaps, 1);
      expect(focusNode.hasFocus, isFalse);
    },
  );

  testWidgets('scrolling a form keeps the keyboard open', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => KeyboardDismissScope(child: child!),
        home: Scaffold(
          body: ListView(
            children: [
              TextField(key: const Key('field'), focusNode: focusNode),
              for (var i = 0; i < 30; i++) ListTile(title: Text('Row $i')),
            ],
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('field')));
    await tester.pump();

    await tester.drag(find.text('Row 5'), const Offset(0, -200));
    await tester.pump();
    expect(focusNode.hasFocus, isTrue);
  });
}
