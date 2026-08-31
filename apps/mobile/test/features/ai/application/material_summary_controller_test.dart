import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/core/api/api_exception.dart';
import 'package:studafy_mobile/src/features/ai/application/material_summary_controller.dart';
import 'package:studafy_mobile/src/features/ai/data/ai_study_client.dart';
import 'package:studafy_mobile/src/features/ai/domain/ai_study.dart';

/// Hand-written fake — same rationale as `_FakeAskAiClient`: [AiStudyClient] is a thin Dio
/// wrapper. `implements` only needs the three methods; the one field is private.
class _FakeAiStudyClient implements AiStudyClient {
  _FakeAiStudyClient({this.summarizeHandler});

  /// Overrides one `summarize` call; the default returns a distinct summary per preset.
  Future<AiSummary> Function(AiSummaryLength length)? summarizeHandler;

  int summarizeCalls = 0;
  final List<AiSummaryLength> requestedLengths = [];

  @override
  Future<AiSummary> summarize({
    required String studentId,
    required String materialId,
    required AiSummaryLength length,
  }) async {
    summarizeCalls++;
    requestedLengths.add(length);
    final handler = summarizeHandler;
    if (handler != null) return handler(length);
    return AiSummary(
      text: 'summary:${length.name}',
      length: length,
      cached: false,
      sources: const [],
    );
  }

  @override
  Future<List<AiConcept>> concepts({
    required String studentId,
    required String materialId,
  }) async => const [];

  @override
  Future<AiUsage> usage() async =>
      const AiUsage(active: true, budget: 100, usedTokens: 0, heldTokens: 0, remaining: 100);
}

MaterialSummaryController _controllerFor(
  _FakeAiStudyClient client, {
  void Function()? onUsageChanged,
}) => MaterialSummaryController(
  client: client,
  studentId: 'student-1',
  materialId: 'material-1',
  onUsageChanged: onUsageChanged,
);

void main() {
  group('MaterialSummaryController.select', () {
    test('fetches the requested preset and exposes it as current', () async {
      final client = _FakeAiStudyClient();
      final controller = _controllerFor(client);

      await controller.select(AiSummaryLength.standard);

      expect(controller.selected, AiSummaryLength.standard);
      expect(controller.current?.text, 'summary:standard');
      expect(controller.isLoading, isFalse);
      expect(controller.error, isNull);
      expect(client.summarizeCalls, 1);
    });

    test('switching back to an already-fetched preset is synchronous and makes no call', () async {
      final client = _FakeAiStudyClient();
      final controller = _controllerFor(client);

      await controller.select(AiSummaryLength.standard);
      await controller.select(AiSummaryLength.detailed);
      expect(client.summarizeCalls, 2);

      // No await: a cached preset must be in place the instant select() returns.
      final pending = controller.select(AiSummaryLength.standard);
      expect(controller.selected, AiSummaryLength.standard);
      expect(controller.current?.text, 'summary:standard');
      expect(controller.isLoading, isFalse);
      await pending;

      expect(client.summarizeCalls, 2);
      expect(client.requestedLengths, [AiSummaryLength.standard, AiSummaryLength.detailed]);
    });

    test('classifies a quota problem and leaves no summary for the preset', () async {
      final client = _FakeAiStudyClient(
        summarizeHandler: (_) => throw const ApiException(
          status: 429,
          title: 'quota',
          code: 'AI_QUOTA_EXCEEDED',
        ),
      );
      final controller = _controllerFor(client);

      await controller.select(AiSummaryLength.standard);

      expect(controller.error, AiStudyError.quotaExceeded);
      expect(controller.current, isNull);
      expect(controller.isLoading, isFalse);
    });

    test('retry re-runs the fetch for the selected preset', () async {
      var attempts = 0;
      final client = _FakeAiStudyClient(
        summarizeHandler: (length) async {
          attempts++;
          if (attempts == 1) {
            throw DioException(
              requestOptions: RequestOptions(path: '/summarize'),
              type: DioExceptionType.connectionError,
            );
          }
          return AiSummary(text: 'recovered', length: length, cached: false, sources: const []);
        },
      );
      final controller = _controllerFor(client);

      await controller.select(AiSummaryLength.brief);
      expect(controller.error, AiStudyError.network);

      await controller.retry();
      expect(controller.error, isNull);
      expect(controller.current?.text, 'recovered');
      expect(attempts, 2);
    });

    test('reports a fresh generation but not a cache hit to onUsageChanged', () async {
      var usageChanges = 0;
      final client = _FakeAiStudyClient(
        summarizeHandler: (length) async => AiSummary(
          text: 'x',
          length: length,
          cached: length == AiSummaryLength.detailed,
          sources: const [],
        ),
      );
      final controller = _controllerFor(client, onUsageChanged: () => usageChanges++);

      await controller.select(AiSummaryLength.standard); // fresh
      await controller.select(AiSummaryLength.detailed); // server-cached

      expect(usageChanges, 1);
    });
  });
}
