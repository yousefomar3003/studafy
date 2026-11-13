import 'dart:io';

/// Validates that `client:generate` (ST-062) succeeded and produced a usable client. Run via
/// `bun run client:check-drift` from apps/mobile, or `bun run mobile:client:check-drift` from the
/// repo root — see lib/src/core/api/README.md.
///
/// The generated tree is gitignored (see ../../.gitignore) rather than committed, so — same as
/// packages/api-client/scripts/check-drift.ts for the TypeScript client — this is a smoke test
/// that generation ran and is internally consistent, not a diff against a committed copy. Real
/// drift protection is regeneration itself: apps/api/openapi.json is the single source, so a route
/// or schema change can only ever be reflected by rerunning `client:generate`, and CI does that on
/// every run before this check.
void main() {
  final generatedDir = Directory('lib/src/core/api/generated');
  var failed = false;

  void checkNonEmpty(String relativePath) {
    final file = File('${generatedDir.path}/$relativePath');
    if (!file.existsSync() || file.lengthSync() == 0) {
      stderr.writeln("ERROR: ${file.path} is missing or empty. Run 'bun run client:generate'.");
      failed = true;
    }
  }

  if (!generatedDir.existsSync()) {
    stderr.writeln("ERROR: ${generatedDir.path} not found. Run 'bun run client:generate'.");
    exitCode = 1;
    return;
  }

  // The root client (every domain client hangs off it) and the one endpoint this ticket's
  // acceptance criteria exercises end to end: model through client through build_runner output.
  checkNonEmpty('studafy_api_client.dart');
  checkNonEmpty('health/health_client.dart');
  checkNonEmpty('health/health_client.g.dart');
  checkNonEmpty('models/health_ok.g.dart');

  // A blanket sweep for the two known codegen-bug patterns scripts/fix_*.dart repair: a `part`
  // file a generated file declares but that was never written is exactly what a regression in
  // either fixer, or an upstream swagger_parser update that changes the bug's shape, produces —
  // and it fails the whole package's compile, not just one model, so it is worth catching here
  // with a precise message rather than only downstream in `flutter test`/`flutter analyze`.
  final partPattern = RegExp(r"^part '([^']+)';", multiLine: true);
  var fileCount = 0;
  for (final entry in generatedDir.listSync(recursive: true)) {
    if (entry is! File || !entry.path.endsWith('.dart')) continue;
    fileCount++;
    if (entry.path.endsWith('.g.dart')) continue;

    final match = partPattern.firstMatch(entry.readAsStringSync());
    if (match == null) continue;
    final partFile = File('${entry.parent.path}/${match.group(1)}');
    if (!partFile.existsSync() || partFile.lengthSync() == 0) {
      stderr.writeln('ERROR: ${entry.path} declares part \'${match.group(1)}\' which was never written.');
      failed = true;
    }
  }

  if (failed) {
    exitCode = 1;
    return;
  }
  stdout.writeln('api-client generated at ${generatedDir.path} ($fileCount files).');
}
