import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// Age branching (ST-309) — see `docs/compliance/childrens-data-dossier.md` at the repo root.
///
/// The app never asks for or reads a user's age, and every user of a role gets the same features,
/// so it has no neutral age screen. Google Play's Families policy requires one as soon as behaviour
/// depends on age. This test fails when app code starts reading a date of birth or gating on age,
/// so that change has to add a neutral age screen and update the store answers with it.
void main() {
  test('no app code reads a date of birth or gates on age', () {
    final ageSignal = RegExp(
      r'\b(dateOfBirth|DateOfBirth|date_of_birth|birthDate|birthday|[Aa]geGate|[Aa]geScreen|'
      r'isMinor|isAdult|isUnder13|ageInYears)\b',
    );

    final violations = Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'))
        // The generated API client mirrors the admin student-profile schema, which carries the
        // date of birth a school may enter. Reading it from app code is what this test catches.
        .where((file) => !file.uri.path.contains('lib/src/core/api/generated/'))
        .where((file) => ageSignal.hasMatch(file.readAsStringSync()))
        .map((file) => file.path)
        .toList();

    expect(
      violations,
      isEmpty,
      reason: 'age-dependent behaviour needs a neutral age screen and new store answers first',
    );
  });
}
