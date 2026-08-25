import 'dart:io';

/// Repairs a second `swagger_parser` 1.44.1 bug: a boolean single-value enum (OpenAPI 3.1
/// `{"type": "boolean", "enum": [true]}` — the API's recurring "always-true" acknowledgement
/// idiom, e.g. `LogoutResult.ended`, `WebhookAccepted.ok`) is emitted as a string-enum, passing a
/// quoted `'true'`/`'false'` to its own const constructor where the generated `bool? json` field
/// requires an unquoted literal. Every such file fails to compile with "A value of type 'String'
/// can't be assigned to a parameter of type 'bool?'".
///
/// Only the enum constant's own constructor call is wrong — `@JsonValue('true')` right above it
/// is correct as-is and must stay quoted: `json_annotation`'s `JsonValue` only accepts
/// String/int/null, never bool, and this class's hand-rolled `fromJson` ignores it anyway
/// (matching on `.json` directly). Scoped to files declaring `final bool? json;` — the marker
/// this bug's template leaves behind — so it can never touch a string- or int-backed enum, and
/// excludes the `@JsonValue(...)` line by name so a correct annotation is never touched.
/// Idempotent: an already-correct file (unquoted literals) matches nothing.
///
/// Run via `dart run scripts/fix_boolean_enum_literals.dart` from `apps/mobile`, alongside
/// `fix_sealed_union_imports.dart` (see `scripts/generate_api_client.sh`).
void main() {
  final modelsDir = Directory('lib/src/core/api/generated/models');
  if (!modelsDir.existsSync()) {
    stderr.writeln('${modelsDir.path} not found — run swagger_parser generate first.');
    exitCode = 1;
    return;
  }

  final quotedBoolConstructorArg = RegExp(r"(?<!JsonValue)\('(true|false)'\)");
  var filesFixed = 0;

  for (final entry in modelsDir.listSync()) {
    if (entry is! File || !entry.path.endsWith('.dart') || entry.path.endsWith('.g.dart')) {
      continue;
    }
    final contents = entry.readAsStringSync();
    if (!contents.contains('final bool? json;')) {
      continue;
    }

    final patched = contents.replaceAllMapped(
      quotedBoolConstructorArg,
      (m) => '(${m[1]})',
    );
    if (patched == contents) {
      continue;
    }

    entry.writeAsStringSync(patched);
    filesFixed++;
    stdout.writeln('fix_boolean_enum_literals: patched ${entry.path}');
  }

  stdout.writeln('fix_boolean_enum_literals: fixed $filesFixed file(s).');
}
