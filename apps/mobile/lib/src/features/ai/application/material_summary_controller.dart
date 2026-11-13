import 'package:flutter/foundation.dart';

import '../data/ai_study_client.dart';
import '../domain/ai_study.dart';

/// Drives one material's summary screen: holds the summary for each length preset it has fetched
/// and switches between them.
///
/// A plain [ChangeNotifier], not a Riverpod provider — same call as `AskAiController`: the state
/// belongs to exactly one screen for its lifetime and is read nowhere else. Created in the
/// screen's `State` with the client and student id resolved from providers, and disposed with it.
///
/// The per-preset [_cache] is what makes a preset switch instant: [select] returns synchronously
/// when the target preset is already in it, so the screen re-renders with no spinner and no
/// network. Only the first switch to each preset costs a request; the server then serves repeats
/// of that preset from its own cache for nothing.
class MaterialSummaryController extends ChangeNotifier {
  // Private fields kept off the public constructor signature (callers pass `client:` etc.), same
  // as `AskAiController`.
  MaterialSummaryController({
    required AiStudyClient client,
    required String studentId,
    required String materialId,
    VoidCallback? onUsageChanged,
  }) : _client = client, // ignore: prefer_initializing_formals
       _studentId = studentId, // ignore: prefer_initializing_formals
       _materialId = materialId, // ignore: prefer_initializing_formals
       _onUsageChanged = onUsageChanged; // ignore: prefer_initializing_formals

  final AiStudyClient _client;
  final String _studentId;
  final String _materialId;

  /// Called after a fresh (non-cached) generation so the screen can refresh the quota meter.
  final VoidCallback? _onUsageChanged;

  final Map<AiSummaryLength, AiSummary> _cache = {};

  AiSummaryLength _selected = AiSummaryLength.standard;
  AiSummaryLength get selected => _selected;

  bool _loading = false;

  /// True while the *selected* preset is being fetched for the first time.
  bool get isLoading => _loading;

  AiStudyError? _error;

  /// The failure for the selected preset's last fetch, or null. Cleared when a fetch starts or the
  /// selection moves to a cached preset.
  AiStudyError? get error => _error;

  /// The summary for the selected preset, or null while its first fetch runs (or after it failed).
  AiSummary? get current => _cache[_selected];

  bool _disposed = false;

  /// Selects [length]. Synchronous and network-free when that preset is already cached; otherwise
  /// fetches it once.
  Future<void> select(AiSummaryLength length) async {
    _selected = length;
    if (_cache.containsKey(length)) {
      _error = null;
      notifyListeners();
      return;
    }
    await _fetch(length);
  }

  /// Re-runs the fetch for the selected preset after a failure.
  Future<void> retry() => _fetch(_selected);

  Future<void> _fetch(AiSummaryLength length) async {
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      final summary = await _client.summarize(
        studentId: _studentId,
        materialId: _materialId,
        length: length,
      );
      if (_disposed) return;
      _cache[length] = summary;
      if (!summary.cached) _onUsageChanged?.call();
    } catch (error) {
      if (_disposed || _selected != length) return;
      _error = AiStudyError.classify(error);
    } finally {
      // Only the fetch for the still-selected preset owns the shared loading flag; a stale one
      // (the user switched away mid-flight) leaves it to whichever fetch is current.
      if (!_disposed && _selected == length) {
        _loading = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
