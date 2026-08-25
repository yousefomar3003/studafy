import 'dart:io';

/// Repairs a missing-import bug in `swagger_parser` 1.44.1's `json_serializable` output for
/// `oneOf` schemas whose variants have an inline (unnamed) enum property — e.g.
/// `FinanceExportRequest`'s `report_type`/`file_format` discriminator fields. The tool emits a
/// correctly named enum file for each such property but never imports it into the `*_sealed.dart`
/// file that declares the field, so the sealed file fails to compile ("type InvalidType").
///
/// This is a generation-pipeline step, not a hand-patch of committed output: `generated/` is
/// gitignored (see ../lib/src/core/api/README.md) and rebuilt by every `client:generate` run, so
/// nothing here is ever hand-edited in place. It scans every `sealed class` file under
/// `generated/models/`, and — using a name→file map built from the actual generated declarations,
/// not a guessed naming convention — adds whichever sibling imports the file's field types need
/// but don't already have. Idempotent: re-running it against already-correct output is a no-op.
///
/// Run via `dart run scripts/fix_sealed_union_imports.dart` from `apps/mobile`, between
/// `swagger_parser generate` and `build_runner build` (see `scripts/generate_api_client.sh`).
void main() {
  final modelsDir = Directory('lib/src/core/api/generated/models');
  if (!modelsDir.existsSync()) {
    stderr.writeln('${modelsDir.path} not found — run swagger_parser generate first.');
    exitCode = 1;
    return;
  }

  final modelFiles = modelsDir
      .listSync()
      .whereType<File>()
      .where((file) => file.path.endsWith('.dart') && !file.path.endsWith('.g.dart'))
      .toList();

  // name -> declaring file's basename, e.g. "FinanceExportRequestUnionVariant1ReportType" ->
  // "finance_export_request_union_variant1_report_type.dart". Built from the generated
  // declarations themselves so it can never drift from swagger_parser's own naming.
  final declarationPattern = RegExp(r'^(?:sealed\s+)?(?:class|enum)\s+(\w+)', multiLine: true);
  final declaredIn = <String, String>{};
  for (final file in modelFiles) {
    final basename = file.uri.pathSegments.last;
    for (final match in declarationPattern.allMatches(file.readAsStringSync())) {
      declaredIn[match.group(1)!] = basename;
    }
  }

  final typeTokenPattern = RegExp(r'\b[A-Z]\w*\b');
  final importPattern = RegExp(r"^import\s+'([\w.]+\.dart)';", multiLine: true);
  var filesFixed = 0;

  for (final file in modelFiles) {
    final contents = file.readAsStringSync();
    if (!contents.contains('sealed class')) {
      continue;
    }

    final ownNames = declarationPattern.allMatches(contents).map((m) => m.group(1)!).toSet();
    final alreadyImported = importPattern.allMatches(contents).map((m) => m.group(1)!).toSet();

    final missingImports = <String>{};
    for (final token in typeTokenPattern.allMatches(contents).map((m) => m[0]!)) {
      if (ownNames.contains(token)) continue;
      final declaringFile = declaredIn[token];
      if (declaringFile == null || alreadyImported.contains(declaringFile)) continue;
      missingImports.add(declaringFile);
    }

    if (missingImports.isEmpty) {
      continue;
    }

    final newImportLines = missingImports.map((f) => "import '$f';").toList()..sort();
    final lastImportMatch = importPattern.allMatches(contents).lastOrNull;
    final insertAt = lastImportMatch != null
        ? lastImportMatch.end
        : contents.indexOf("import 'package:json_annotation/json_annotation.dart';") +
            "import 'package:json_annotation/json_annotation.dart';".length;

    final patched = contents.replaceRange(insertAt, insertAt, '\n${newImportLines.join('\n')}');
    file.writeAsStringSync(patched);
    filesFixed++;
    stdout.writeln('fix_sealed_union_imports: patched ${file.path} (+${missingImports.length})');
  }

  stdout.writeln('fix_sealed_union_imports: checked ${modelFiles.length} models, fixed $filesFixed.');
}
