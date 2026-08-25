import 'dart:math' as math;

/// Jittered exponential backoff for socket reconnects. Pure and side-effect free so it can be unit
/// tested in isolation and injected with a deterministic [random]. Mirrors
/// `apps/web/src/lib/realtime/backoff.ts`.
class RealtimeBackoff {
  const RealtimeBackoff({
    this.baseDelay = const Duration(seconds: 1),
    this.maxDelay = const Duration(seconds: 30),
    this.jitterRatio = 0.2,
  });

  /// First non-jittered delay.
  final Duration baseDelay;

  /// Ceiling on the raw (pre-jitter) delay.
  final Duration maxDelay;

  /// Upper bound on the uniform jitter fraction applied to each raw delay.
  final double jitterRatio;

  /// Returns the delay before reconnect attempt [attempt] (0-based). The raw delay grows
  /// exponentially (`baseDelay * 2^attempt`, capped at [maxDelay]) and is then jittered by up to
  /// `±jitterRatio`, so retries spread out instead of stampeding while still backing off overall.
  /// [random] should return a value in `[0, 1)`, e.g. `Random().nextDouble`.
  Duration delayFor(int attempt, double Function() random) {
    final rawMs = math.min(
      baseDelay.inMilliseconds * math.pow(2, math.max(0, attempt)),
      maxDelay.inMilliseconds,
    );
    final jitter = (random() * 2 - 1) * jitterRatio;
    final jitteredMs = math.max(0, (rawMs * (1 + jitter)).round());
    return Duration(milliseconds: jitteredMs);
  }
}
