import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/kit/kit.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';

Future<void> _pump(
  WidgetTester tester,
  Widget child, {
  TextDirection direction = TextDirection.ltr,
  ThemeData? theme,
}) async {
  tester.view
    ..physicalSize = const Size(390, 1600)
    ..devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: theme ?? AppTheme.light,
      debugShowCheckedModeBanner: false,
      home: Directionality(
        textDirection: direction,
        child: Scaffold(
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: child,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// Asserts [lead] sits on the start side of [text]: left of it in LTR, right of it in RTL.
void _expectLeadsText(
  WidgetTester tester,
  Finder lead,
  Finder text,
  TextDirection direction,
) {
  final leadRect = tester.getRect(lead);
  final textRect = tester.getRect(text);
  if (direction == TextDirection.ltr) {
    expect(leadRect.right, lessThanOrEqualTo(textRect.left));
  } else {
    expect(leadRect.left, greaterThanOrEqualTo(textRect.right));
  }
}

/// One of each component, for the contrast sweep.
Widget _gallery() {
  return Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const AppHeroCard(
        icon: Icons.calculate_outlined,
        eyebrow: 'MATH101-A',
        title: 'Mathematics',
        subtitle: '28 students',
      ),
      const SizedBox(height: 16),
      AppSectionCard(
        title: 'Today',
        icon: Icons.schedule_outlined,
        trailing: const AppStatusPill(label: '3', tone: AppTone.warning),
        child: Column(
          children: [
            for (final tone in AppTone.values)
              AppIconListTile(
                title: 'Row ${tone.name}',
                subtitle: 'Subtitle',
                icon: Icons.class_outlined,
                accent: tone.accent,
                trailing: AppStatusPill(
                  label: tone.name,
                  tone: tone,
                  icon: Icons.check,
                ),
                onTap: () {},
              ),
          ],
        ),
      ),
      const SizedBox(height: 16),
      Row(
        children: [
          for (final accent in [
            AppAccent.blue,
            AppAccent.violet,
            AppAccent.amber,
          ])
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(4),
                child: AppStatTile(
                  value: '78%',
                  label: 'Average',
                  icon: Icons.percent,
                  accent: accent,
                ),
              ),
            ),
        ],
      ),
      const AppEmptyState(
        icon: Icons.inbox_outlined,
        title: 'Nothing yet',
        message: 'No work.',
      ),
      const AppEmptyState(
        compact: true,
        icon: Icons.error_outline,
        message: 'Failed.',
      ),
    ],
  );
}

void main() {
  for (final direction in TextDirection.values) {
    group('in ${direction.name.toUpperCase()}', () {
      testWidgets(
        'AppIconListTile leads with its badge, ends with trailing and a chevron',
        (tester) async {
          var taps = 0;
          await _pump(
            tester,
            AppIconListTile(
              title: 'Mathematics',
              subtitle: 'Midterm',
              icon: Icons.calculate_outlined,
              trailing: const AppStatusPill(
                label: '92/100',
                tone: AppTone.success,
              ),
              footer: const Text('footer'),
              onTap: () => taps++,
            ),
            direction: direction,
          );

          expect(find.text('Mathematics'), findsOneWidget);
          expect(find.text('Midterm'), findsOneWidget);
          expect(find.text('92/100'), findsOneWidget);
          expect(find.text('footer'), findsOneWidget);
          expect(find.byIcon(Icons.chevron_right), findsOneWidget);
          _expectLeadsText(
            tester,
            find.byType(AppIconBadge),
            find.text('Mathematics'),
            direction,
          );
          // The pill sits on the end side, beyond the title.
          _expectLeadsText(
            tester,
            find.text('Mathematics'),
            find.text('92/100'),
            direction,
          );

          await tester.tap(find.text('Mathematics'));
          expect(taps, 1);
        },
      );

      testWidgets('AppIconListTile without onTap has no chevron and no ink', (
        tester,
      ) async {
        await _pump(
          tester,
          const AppIconListTile(title: 'Plain', badgeLabel: '3'),
          direction: direction,
        );
        expect(find.byIcon(Icons.chevron_right), findsNothing);
        expect(find.byType(InkWell), findsNothing);
        expect(find.text('3'), findsOneWidget);
      });

      testWidgets('AppIconListCard takes taps anywhere on the card', (
        tester,
      ) async {
        var taps = 0;
        await _pump(
          tester,
          AppIconListCard(
            title: 'MATH101-A',
            subtitle: 'Mathematics',
            icon: Icons.calculate_outlined,
            trailing: const AppStatusPill(label: '28 students'),
            onTap: () => taps++,
          ),
          direction: direction,
        );
        await tester.tap(find.byType(AppIconBadge));
        await tester.tap(find.text('28 students'));
        expect(taps, 2);
        expect(find.byIcon(Icons.chevron_right), findsOneWidget);
        _expectLeadsText(
          tester,
          find.byType(AppIconBadge),
          find.text('MATH101-A'),
          direction,
        );
      });

      testWidgets(
        'AppSectionCard shows a header badge, title and trailing over its body',
        (tester) async {
          await _pump(
            tester,
            const AppSectionCard(
              title: 'Due soon',
              icon: Icons.assignment_outlined,
              accent: AppAccent.amber,
              trailing: AppStatusPill(label: '2'),
              child: Text('body'),
            ),
            direction: direction,
          );
          expect(find.text('Due soon'), findsOneWidget);
          expect(find.text('body'), findsOneWidget);
          expect(find.byType(Card), findsOneWidget);
          _expectLeadsText(
            tester,
            find.byType(AppIconBadge),
            find.text('Due soon'),
            direction,
          );
          _expectLeadsText(
            tester,
            find.text('Due soon'),
            find.text('2'),
            direction,
          );
          expect(
            tester.getRect(find.text('body')).top,
            greaterThan(tester.getRect(find.text('Due soon')).bottom),
          );
          // The title is announced as a heading.
          expect(
            tester.getSemantics(find.text('Due soon')),
            isSemantics(isHeader: true),
          );
        },
      );

      testWidgets('AppCollapsibleSectionCard folds and unfolds its body', (
        tester,
      ) async {
        final changes = <bool>[];
        await _pump(
          tester,
          AppCollapsibleSectionCard(
            title: 'Week 1',
            icon: Icons.folder_outlined,
            onExpansionChanged: changes.add,
            child: const Text('materials'),
          ),
          direction: direction,
        );
        expect(find.text('materials'), findsOneWidget);
        final handle = tester.ensureSemantics();
        expect(
          tester.getSemantics(find.byType(InkWell)),
          isSemantics(
            isButton: true,
            hasExpandedState: true,
            isExpanded: true,
            hasTapAction: true,
          ),
        );

        await tester.tap(find.text('Week 1'));
        await tester.pumpAndSettle();
        expect(find.text('materials'), findsNothing);
        expect(changes, [false]);

        await tester.tap(find.text('Week 1'));
        await tester.pumpAndSettle();
        expect(find.text('materials'), findsOneWidget);
        expect(changes, [false, true]);
        handle.dispose();
      });

      testWidgets('AppCollapsibleSectionCard can start collapsed', (
        tester,
      ) async {
        await _pump(
          tester,
          const AppCollapsibleSectionCard(
            title: 'Week 2',
            icon: Icons.folder_outlined,
            initiallyExpanded: false,
            child: Text('hidden'),
          ),
          direction: direction,
        );
        expect(find.text('hidden'), findsNothing);
      });

      testWidgets(
        'AppHeroCard renders structured content with the icon on the start side',
        (tester) async {
          await _pump(
            tester,
            const AppHeroCard(
              icon: Icons.calculate_outlined,
              eyebrow: 'MATH101-A',
              title: 'Mathematics',
              subtitle: '28 students',
              footer: Text('footer'),
            ),
            direction: direction,
          );
          for (final text in [
            'MATH101-A',
            'Mathematics',
            '28 students',
            'footer',
          ]) {
            expect(find.text(text), findsOneWidget);
          }
          _expectLeadsText(
            tester,
            find.byIcon(Icons.calculate_outlined),
            find.text('Mathematics'),
            direction,
          );
          final title = tester.widget<Text>(find.text('Mathematics'));
          expect(title.style?.color, AppHeroCard.foreground);
        },
      );

      testWidgets('AppStatTile shows value over label', (tester) async {
        await _pump(
          tester,
          const AppStatTile(
            value: '78%',
            label: 'Term average',
            icon: Icons.percent,
          ),
          direction: direction,
        );
        expect(
          tester.getRect(find.text('78%')).bottom,
          lessThanOrEqualTo(tester.getRect(find.text('Term average')).top),
        );
      });

      testWidgets('AppStatusPill puts its icon before the label', (
        tester,
      ) async {
        await _pump(
          tester,
          const Align(
            alignment: AlignmentDirectional.centerStart,
            child: AppStatusPill(
              label: 'Recorded',
              tone: AppTone.success,
              icon: Icons.check,
            ),
          ),
          direction: direction,
        );
        _expectLeadsText(
          tester,
          find.byIcon(Icons.check),
          find.text('Recorded'),
          direction,
        );
      });

      testWidgets(
        'AppEmptyState: compact is one row, full is centred with an action',
        (tester) async {
          await _pump(
            tester,
            Column(
              children: [
                const AppEmptyState(
                  compact: true,
                  icon: Icons.inbox_outlined,
                  message: 'Nothing due.',
                ),
                AppEmptyState(
                  icon: Icons.school_outlined,
                  title: 'No classes',
                  message: 'You lead no classes this term.',
                  action: TextButton(
                    onPressed: () {},
                    child: const Text('Refresh'),
                  ),
                ),
              ],
            ),
            direction: direction,
          );
          _expectLeadsText(
            tester,
            find.byIcon(Icons.inbox_outlined),
            find.text('Nothing due.'),
            direction,
          );
          expect(find.text('Refresh'), findsOneWidget);
          final icon = tester.getCenter(find.byIcon(Icons.school_outlined));
          final title = tester.getCenter(find.text('No classes'));
          expect(icon.dx, moreOrLessEquals(title.dx, epsilon: 1));
          // The illustration is decorative.
          expect(
            find.descendant(
              of: find.byType(ExcludeSemantics),
              matching: find.byIcon(Icons.school_outlined),
            ),
            findsOneWidget,
          );
        },
      );

      for (final (name, theme) in [
        ('light', AppTheme.light),
        ('dark', AppTheme.dark),
      ]) {
        testWidgets(
          'every component meets the text contrast guideline ($name)',
          (tester) async {
            final handle = tester.ensureSemantics();
            await _pump(tester, _gallery(), direction: direction, theme: theme);
            await expectLater(tester, meetsGuideline(textContrastGuideline));
            handle.dispose();
          },
        );
      }
    });
  }

  testWidgets('AppIconBadge filled swaps to the solid colours', (tester) async {
    await _pump(
      tester,
      const Row(
        children: [
          AppIconBadge(icon: Icons.star, accent: AppAccent.violet),
          AppIconBadge(
            icon: Icons.star,
            accent: AppAccent.violet,
            filled: true,
          ),
        ],
      ),
    );
    final icons = tester.widgetList<Icon>(find.byIcon(Icons.star)).toList();
    expect(icons[0].color, AppAccent.violet.light.onContainer);
    expect(icons[1].color, AppAccent.violet.light.onSolid);
  });

  testWidgets('kit colours follow the theme brightness', (tester) async {
    await _pump(
      tester,
      const AppIconBadge(icon: Icons.star, accent: AppAccent.emerald),
      theme: AppTheme.dark,
    );
    expect(
      tester.widget<Icon>(find.byIcon(Icons.star)).color,
      AppAccent.emerald.dark.onContainer,
    );
  });
}
