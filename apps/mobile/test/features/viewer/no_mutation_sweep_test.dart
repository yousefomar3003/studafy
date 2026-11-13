import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Static source sweep for the viewer shell's zero-mutation acceptance criterion: it must never
/// contain a call site that could reach a mutating endpoint, not just avoid rendering mutation
/// UI. Two checks, both against every `.dart` file under `lib/src/features/viewer`:
///
/// 1. No direct Dio mutation call (`.post(`, `.put(`, `.patch(`, `.delete(`) — what a hand-written
///    client (like `FinancePaymentsClient`) would use.
/// 2. No call to a method the generated `StudafyApiClient` itself annotates as mutating
///    (`@POST`/`@PUT`/`@PATCH`/`@DELETE` in `core/api/generated/**/*_client.dart`) — what a
///    generated client call (like `apiClientProvider.discipline.createDisciplineIncident`) would
///    use.
///
/// Source-level rather than widget-tree: "no mutation affordance" only proves nothing is wired to
/// a button today; this proves no mutating call exists in the feature's code at all, so one can't
/// get wired to a button — or a `RefreshIndicator`, or a `ref.listen` — as the feature grows.
void main() {
  test('viewer feature has no reachable mutation call sites', () {
    final viewerDartFiles = Directory('lib/src/features/viewer')
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'))
        .toList();
    expect(viewerDartFiles, isNotEmpty, reason: 'viewer feature directory not found or empty');

    final mutatingMethodNames = _generatedMutatingMethodNames();
    expect(
      mutatingMethodNames,
      isNotEmpty,
      reason: 'sanity check: no @POST/@PUT/@PATCH/@DELETE methods found in generated clients',
    );

    const directDioMutationPattern = r'\.(post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(';
    final directDioMutation = RegExp(directDioMutationPattern);

    final violations = <String>[];
    for (final file in viewerDartFiles) {
      final content = file.readAsStringSync();

      for (final match in directDioMutation.allMatches(content)) {
        violations.add('${file.path}: direct Dio mutation call `${match.group(0)!.trim()}`');
      }

      for (final methodName in mutatingMethodNames) {
        if (RegExp('\\.$methodName\\s*\\(').hasMatch(content)) {
          violations.add('${file.path}: calls generated mutation `$methodName(...)`');
        }
      }
    }

    expect(
      violations,
      isEmpty,
      reason: 'Viewer shells must be zero-mutation. Found:\n${violations.join('\n')}',
    );
  });
}

/// Every method name annotated `@POST`, `@PUT`, `@PATCH`, or `@DELETE` in a generated Retrofit
/// client (`*_client.dart`, never its paired `.g.dart`) — the full set of calls that mutate
/// server state through `StudafyApiClient`.
Set<String> _generatedMutatingMethodNames() {
  final clientFiles = Directory('lib/src/core/api/generated')
      .listSync(recursive: true)
      .whereType<File>()
      .where((file) => file.path.endsWith('_client.dart') && !file.path.endsWith('.g.dart'));

  // The annotation and the method signature it applies to are always adjacent (Retrofit requires
  // it); `Future<ReturnType>` can itself wrap onto its own line before the method name on a long
  // signature, which is why the whitespace between them is `\s+` (any whitespace, newlines
  // included) rather than a single space.
  final annotatedMethod = RegExp(
    r'''@(?:POST|PUT|PATCH|DELETE)\((?:'[^']*'|"[^"]*")\)\s*\n\s*Future<[\w<>,\s]+>\s+(\w+)\s*\(''',
  );

  final names = <String>{};
  for (final file in clientFiles) {
    for (final match in annotatedMethod.allMatches(file.readAsStringSync())) {
      names.add(match.group(1)!);
    }
  }
  return names;
}
