/// Coverage gate thresholds for `flutter test --coverage` (ST-245).
///
/// [gateHistory] is a ratchet: it may only ever gain entries that raise a threshold, never
/// lower one -- enforced by `test/tooling/coverage_gates_ratchet_test.dart`. The last entry is
/// the one CI enforces; see `scripts/check_coverage.dart`. To raise a threshold, append a new
/// entry once `flutter test --coverage` + the checker already clears the new numbers locally --
/// never edit an existing entry.
///
/// Every `lib/` file falls into exactly one of two buckets, by path:
///
/// - **API service layer**: `lib/src/core/api/**` (excluding the gitignored, generated
///   `core/api/generated/`), `lib/src/core/network/**`, and every hand-written
///   `lib/src/features/*/data/**` client -- the surfaces the OpenAPI-tag exclusions in
///   `pubspec.yaml` push out of codegen (see `lib/src/core/api/README.md`).
/// - **packages**: everything else under `lib/`.
class CoverageGate {
  const CoverageGate({
    required this.date,
    required this.apiServiceLayer,
    required this.packages,
  });

  /// The day this threshold took effect, `YYYY-MM-DD`. Documentation only -- nothing parses
  /// it -- but it dates the ratchet history the way a changelog entry would.
  final String date;

  /// Minimum required line-coverage percentage (0-100) for the API service layer bucket.
  final int apiServiceLayer;

  /// Minimum required line-coverage percentage (0-100) for the packages bucket.
  final int packages;
}

/// ST-245's stated goal. Not itself enforced -- [gateHistory]'s last entry is -- this is the
/// ceiling the ratchet climbs toward as real coverage improves. See the testing strategy doc
/// (`docs/testing-strategy.md`) for why today's starting point sits well below it: the app
/// carries a large, mostly-untested surface (hand-written data clients tested only through
/// `test_integration/`, several barely-touched feature modules) that predates this ticket, and
/// a hard gate at the target today would fail every PR for reasons this ticket didn't cause.
const CoverageGate targetCoverageGate = CoverageGate(
  date: '2026-09-04',
  apiServiceLayer: 80,
  packages: 70,
);

/// The ratchet. Each entry's thresholds must be greater than or equal to the previous entry's,
/// in both fields -- see [targetCoverageGate] for where this is headed.
const List<CoverageGate> gateHistory = [
  // Baseline: the coverage `flutter test --coverage` actually measured on 2026-09-04, rounded
  // down for headroom against ordinary run-to-run variance. Raise these as real coverage grows.
  CoverageGate(date: '2026-09-04', apiServiceLayer: 8, packages: 50),
];

/// The threshold CI enforces right now.
CoverageGate get currentCoverageGate => gateHistory.last;
