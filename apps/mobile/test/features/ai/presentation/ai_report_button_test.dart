import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/design/theme/app_theme.dart';
import 'package:studafy_mobile/src/features/ai/application/ai_content_report_providers.dart';
import 'package:studafy_mobile/src/features/ai/application/ask_ai_providers.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_content_report_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_content_report.dart';
import 'package:studafy_mobile/src/features/ai/presentation/widgets/ai_report_button.dart';

import '../../../support/wrap_with_localization.dart';

class _FakeReportClient implements AiContentReportClient {
  _FakeReportClient(this.outcome);

  final AiReportOutcome outcome;
  final calls = <(String, AiReportTarget, AiReportReason, String?)>[];

  @override
  Future<AiReportOutcome> report({
    required String studentId,
    required AiReportTarget target,
    required AiReportReason reason,
    String? details,
  }) async {
    calls.add((studentId, target, reason, details));
    return outcome;
  }
}

Widget _host(_FakeReportClient client) {
  return wrapWithLocalization(
    ProviderScope(
      overrides: [
        aiContentReportClientProvider.overrideWithValue(client),
        askAiStudentIdProvider.overrideWithValue('student-1'),
      ],
      child: Builder(
        builder: (context) => MaterialApp(
          theme: AppTheme.light,
          locale: context.locale,
          supportedLocales: context.supportedLocales,
          localizationsDelegates: context.localizationDelegates,
          home: Scaffold(
            appBar: AppBar(actions: const [AiReportButton(target: AiReportTarget.quiz('quiz-1'))]),
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('a reason must be chosen before the report can be sent', (tester) async {
    final client = _FakeReportClient(AiReportOutcome.filed);
    await tester.pumpWidget(_host(client));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.outlined_flag));
    await tester.pumpAndSettle();

    final submit = find.widgetWithText(FilledButton, 'Report');
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);

    await tester.tap(find.text('Sexual content involving a child'));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);
  });

  testWidgets('files the report with the chosen reason and confirms', (tester) async {
    final client = _FakeReportClient(AiReportOutcome.filed);
    await tester.pumpWidget(_host(client));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.outlined_flag));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Wrong or misleading'));
    await tester.enterText(find.byType(TextField), 'Question 2 is wrong');
    await tester.tap(find.widgetWithText(FilledButton, 'Report'));
    await tester.pumpAndSettle();

    final (studentId, target, reason, details) = client.calls.single;
    expect(studentId, 'student-1');
    expect(target.contentType, AiReportContentType.quiz);
    expect(target.contentId, 'quiz-1');
    expect(reason, AiReportReason.inaccurate);
    expect(details, 'Question 2 is wrong');
    expect(find.text('Thanks — your school will review this.'), findsOneWidget);
  });

  testWidgets('says so when the item was already reported', (tester) async {
    final client = _FakeReportClient(AiReportOutcome.alreadyFiled);
    await tester.pumpWidget(_host(client));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.outlined_flag));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Something else'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Report'));
    await tester.pumpAndSettle();

    expect(find.text("You've already reported this."), findsOneWidget);
  });

  testWidgets('cancelling sends nothing', (tester) async {
    final client = _FakeReportClient(AiReportOutcome.filed);
    await tester.pumpWidget(_host(client));
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(Icons.outlined_flag));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    expect(client.calls, isEmpty);
  });
}
