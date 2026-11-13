// Coverage gate for ST-245. Parses the lcov report `flutter test --coverage` writes, buckets
// every `lib/` file into the API service layer or the rest of the app ("packages" -- see
// `tool/coverage_gates.dart` for exactly which paths land in which bucket), and fails the build
// if either bucket's line coverage drops below `currentCoverageGate`. Also writes a per-module
// Markdown report -- the artifact CI attaches to the PR, and (when running in Actions) the job
// summary.
//
// Usage: dart run scripts/check_coverage.dart [path/to/lcov.info]
// Exit codes: 0 compliant, 1 below a threshold, 2 invalid input (missing/unreadable lcov file).
import 'dart:io';

import '../tool/coverage_gates.dart';

/// One `SF:`...`end_of_record` block's line totals.
class _FileCoverage {
  _FileCoverage(this.path, this.linesFound, this.linesHit);

  final String path;
  final int linesFound;
  final int linesHit;
}

class _Tally {
  int linesFound = 0;
  int linesHit = 0;

  void add(_FileCoverage file) {
    linesFound += file.linesFound;
    linesHit += file.linesHit;
  }

  /// Line-coverage percentage. A bucket with no instrumented lines reports 100% -- vacuously
  /// covered, not a failure -- so an empty module never drags a real threshold down.
  double get percent => linesFound == 0 ? 100.0 : linesHit / linesFound * 100;
}

/// `lib/src/features/<name>/data/**` -- the hand-written per-feature API clients (see
/// `lib/src/core/api/README.md`'s excluded OpenAPI tags for why they're hand-written).
final _featureDataClient = RegExp(r'^lib/src/features/[^/]+/data/');

bool _isGenerated(String path) => path.contains('/generated/');

bool _isApiServiceLayer(String path) {
  return path.startsWith('lib/src/core/api/') ||
      path.startsWith('lib/src/core/network/') ||
      _featureDataClient.hasMatch(path);
}

/// Groups a path into a reporting module: `core/api`, `features/teacher`, `design/theme`, etc.
/// Falls back to `root` for the handful of files directly under `lib/src/` (just `app.dart`
/// today).
String _moduleOf(String path) {
  final segments = path.split(
    '/',
  ); // lib, src, <core|features|design>, <name>, ...
  return segments.length >= 4 ? '${segments[2]}/${segments[3]}' : 'root';
}

List<_FileCoverage> _parseLcov(String contents) {
  final files = <_FileCoverage>[];
  String? path;
  var linesFound = 0;
  var linesHit = 0;

  for (final line in contents.split('\n')) {
    if (line.startsWith('SF:')) {
      path = line.substring(3).trim().replaceAll('\\', '/');
      linesFound = 0;
      linesHit = 0;
    } else if (line.startsWith('LF:')) {
      linesFound = int.parse(line.substring(3).trim());
    } else if (line.startsWith('LH:')) {
      linesHit = int.parse(line.substring(3).trim());
    } else if (line.startsWith('end_of_record')) {
      if (path != null) files.add(_FileCoverage(path, linesFound, linesHit));
      path = null;
    }
  }
  return files;
}

String _fmt(double percent) => '${percent.toStringAsFixed(1)}%';

void main(List<String> args) {
  final lcovPath = args.isNotEmpty ? args[0] : 'coverage/lcov.info';
  final lcovFile = File(lcovPath);
  if (!lcovFile.existsSync()) {
    stderr.writeln(
      'check_coverage: $lcovPath not found. Run `flutter test --coverage` first -- it writes '
      'coverage/lcov.info.',
    );
    exit(2);
  }

  final files = _parseLcov(lcovFile.readAsStringSync());
  final gate = currentCoverageGate;

  final apiTally = _Tally();
  final packagesTally = _Tally();
  final moduleTallies = <String, _Tally>{};

  for (final file in files) {
    if (!file.path.startsWith('lib/')) continue;
    if (_isGenerated(file.path)) continue;

    final tally = _isApiServiceLayer(file.path) ? apiTally : packagesTally;
    tally.add(file);
    moduleTallies.putIfAbsent(_moduleOf(file.path), () => _Tally()).add(file);
  }

  final buffer = StringBuffer()
    ..writeln('# Mobile coverage report (ST-245)')
    ..writeln()
    ..writeln('| Bucket | Lines hit / found | Coverage | Threshold | Status |')
    ..writeln('| --- | --- | --- | --- | --- |');

  var passed = true;
  void reportBucket(String name, _Tally tally, int threshold) {
    final ok = tally.percent >= threshold;
    passed &= ok;
    buffer.writeln(
      '| $name | ${tally.linesHit} / ${tally.linesFound} | ${_fmt(tally.percent)} | '
      '$threshold% | ${ok ? '✅ pass' : '❌ fail'} |',
    );
  }

  reportBucket('API service layer', apiTally, gate.apiServiceLayer);
  reportBucket('packages', packagesTally, gate.packages);

  buffer
    ..writeln()
    ..writeln(
      'Target (ST-245): ${targetCoverageGate.apiServiceLayer}% API service layer, '
      '${targetCoverageGate.packages}% packages. The ratchet in `tool/coverage_gates.dart` '
      'only raises the enforced threshold toward that target, never lowers it.',
    )
    ..writeln()
    ..writeln('## Per-module coverage')
    ..writeln()
    ..writeln('| Module | Lines hit / found | Coverage |')
    ..writeln('| --- | --- | --- |');

  final moduleNames = moduleTallies.keys.toList()..sort();
  for (final name in moduleNames) {
    final tally = moduleTallies[name]!;
    buffer.writeln(
      '| $name | ${tally.linesHit} / ${tally.linesFound} | ${_fmt(tally.percent)} |',
    );
  }

  final report = buffer.toString();
  final reportFile = File('${lcovFile.parent.path}/coverage-report.md')
    ..writeAsStringSync(report);
  stdout.write(report);

  final summaryPath = Platform.environment['GITHUB_STEP_SUMMARY'];
  if (summaryPath != null) {
    File(summaryPath).writeAsStringSync(report, mode: FileMode.append);
  }

  if (!passed) {
    stderr.writeln(
      '\ncheck_coverage: below threshold. See ${reportFile.path} for the full breakdown.',
    );
    exit(1);
  }
}
