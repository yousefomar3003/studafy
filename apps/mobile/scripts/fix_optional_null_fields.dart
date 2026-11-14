import 'dart:convert';
import 'dart:io';

/// Stops the generated client from sending `"field": null` for request-body fields the API
/// declares optional but NOT nullable.
///
/// `swagger_parser` emits `@JsonSerializable()` with the default `includeIfNull: true`, so every
/// unset optional field is serialised as an explicit `null`. The API validates bodies with Zod,
/// where `.optional()` accepts a missing key but rejects `null` -- the request fails with 400
/// VALIDATION_FAILED before anything happens. That broke teacher material upload
/// (`CreateMaterialBody.checksum_sha256` / `ConfirmUploadBody.checksum_sha256`) with "Check the
/// details and try again."
///
/// Fields the API marks nullable keep sending `null`: on PATCH bodies an explicit `null` means
/// "clear this value", so dropping it would silently turn a clear into "leave unchanged".
///
/// Scope: schemas reachable from an operation's JSON request body (directly or via nested
/// `$ref`s), so response models are untouched. For each optional, non-nullable property the
/// field's `@JsonKey(...)` gains `includeIfNull: false` (or one is added). Idempotent.
///
/// Run via `dart run scripts/fix_optional_null_fields.dart` from `apps/mobile`, after
/// `swagger_parser generate` (see `scripts/generate_api_client.sh`).
void main() {
  final spec =
      jsonDecode(File('../api/openapi.json').readAsStringSync())
          as Map<String, dynamic>;
  final schemas =
      ((spec['components'] as Map?)?['schemas'] as Map?)
          ?.cast<String, dynamic>() ??
      const <String, dynamic>{};
  final modelsDir = Directory('lib/src/core/api/generated/models');
  if (!modelsDir.existsSync()) {
    stderr.writeln(
      '${modelsDir.path} not found — run swagger_parser generate first.',
    );
    exitCode = 1;
    return;
  }

  // Schemas used as request bodies, plus everything they reference.
  final requestSchemas = <String>{};
  void collectRefs(Object? node) {
    if (node is Map) {
      final ref = node[r'$ref'];
      if (ref is String && ref.startsWith('#/components/schemas/')) {
        final name = ref.substring('#/components/schemas/'.length);
        if (requestSchemas.add(name)) collectRefs(schemas[name]);
      }
      for (final value in node.values) {
        collectRefs(value);
      }
    } else if (node is List) {
      for (final value in node) {
        collectRefs(value);
      }
    }
  }

  final paths =
      (spec['paths'] as Map?)?.cast<String, dynamic>() ??
      const <String, dynamic>{};
  for (final item in paths.values) {
    if (item is! Map) continue;
    for (final operation in item.values) {
      if (operation is Map && operation['requestBody'] != null) {
        collectRefs(operation['requestBody']);
      }
    }
  }

  var fieldsFixed = 0;
  var filesFixed = 0;
  for (final name in requestSchemas) {
    final schema = schemas[name];
    if (schema is! Map || schema['properties'] is! Map) continue;
    final required = ((schema['required'] as List?) ?? const [])
        .cast<String>()
        .toSet();
    final optionalNonNullable = <String>[
      for (final entry
          in (schema['properties'] as Map).cast<String, dynamic>().entries)
        if (!required.contains(entry.key) && !_isNullable(entry.value))
          entry.key,
    ];
    if (optionalNonNullable.isEmpty) continue;

    final file = File('${modelsDir.path}/${_snake(name)}.dart');
    if (!file.existsSync()) continue;
    final original = file.readAsStringSync();
    var contents = original;
    for (final property in optionalNonNullable) {
      final patched = _omitNull(contents, property);
      if (patched != contents) {
        contents = patched;
        fieldsFixed++;
      }
    }
    if (contents != original) {
      file.writeAsStringSync(contents);
      filesFixed++;
    }
  }

  stdout.writeln(
    'fix_optional_null_fields: $fieldsFixed field(s) in $filesFixed file(s) omit null.',
  );
}

bool _isNullable(Object? property) {
  if (property is! Map) return false;
  if (property['nullable'] == true) return true;
  final type = property['type'];
  if (type == 'null' || (type is List && type.contains('null'))) return true;
  for (final key in const ['anyOf', 'oneOf']) {
    final variants = property[key];
    if (variants is List && variants.any(_isNullable)) return true;
  }
  return false;
}

/// `CreateMaterialBody` -> `create_material_body`, matching swagger_parser's file names.
String _snake(String name) => name
    .replaceAllMapped(RegExp(r'([a-z0-9])([A-Z])'), (m) => '${m[1]}_${m[2]}')
    .replaceAllMapped(RegExp(r'([A-Z]+)([A-Z][a-z])'), (m) => '${m[1]}_${m[2]}')
    .toLowerCase();

String _camel(String jsonName) {
  final parts = jsonName.split('_');
  return parts.first +
      parts
          .skip(1)
          .map((p) => p.isEmpty ? p : p[0].toUpperCase() + p.substring(1))
          .join();
}

String _omitNull(String contents, String jsonName) {
  final escaped = RegExp.escape(jsonName);
  // Already has a JsonKey naming it: add the flag once.
  final named = RegExp(
    "@JsonKey\\((?![^)]*includeIfNull)([^)]*name: '$escaped'[^)]*)\\)",
  );
  if (named.hasMatch(contents)) {
    return contents.replaceFirstMapped(
      named,
      (m) => '@JsonKey(includeIfNull: false, ${m[1]})',
    );
  }
  if (RegExp("name: '$escaped'").hasMatch(contents)) {
    return contents; // already patched
  }
  // No JsonKey (the Dart name equals the JSON name): annotate the nullable field.
  final field = RegExp(
    '(\\n([ \\t]*))(final [^;\\n]+\\? ${RegExp.escape(_camel(jsonName))};)',
  );
  final match = field.firstMatch(contents);
  if (match == null) return contents;
  final before = contents.substring(0, match.start);
  if (before.trimRight().endsWith(')') &&
      before.trimRight().split('\n').last.contains('@JsonKey')) {
    return contents; // annotated in a form this script doesn't edit; leave it
  }
  return contents.replaceRange(
    match.start,
    match.end,
    '${match[1]}@JsonKey(includeIfNull: false)\n${match[2]}${match[3]}',
  );
}
