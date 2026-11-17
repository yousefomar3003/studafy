import 'dart:math' as math;

import 'package:intl/intl.dart';

/// Student AI for one school's children, as the parent sees it (`GET /api/parent/student-ai`).
///
/// Hand-parsed rather than the generated `ParentAiOffers`: the generated model types an offer's
/// `window`, `pricing` and `optIn` (and an opt-in's `parent`) as non-null, but the API sends null
/// for each of them in ordinary states (no window yet, already opted in, recorded by the school),
/// so the generated `fromJson` would throw on a closed offer.
class StudentAiOffers {
  const StudentAiOffers({required this.offers, required this.termsVersion});

  factory StudentAiOffers.fromJson(Map<String, Object?> json) => StudentAiOffers(
    offers: [
      for (final entry in (json['offers'] as List<Object?>?) ?? const [])
        StudentAiOffer.fromJson(Map<String, Object?>.from(entry! as Map)),
    ],
    termsVersion: json['termsVersion']! as String,
  );

  /// One per child the school offered Student AI to. Children it never offered it to are not
  /// listed, so an empty list means there is nothing to show.
  final List<StudentAiOffer> offers;

  /// The terms the parent accepts by opting in; sent back with the opt-in.
  final String termsVersion;
}

enum StudentAiOfferState {
  available,
  optedIn,
  closed,

  /// A state this build doesn't know (a newer API). Shown like [closed]: nothing to act on.
  unknown;

  static StudentAiOfferState fromJson(Object? value) => switch (value) {
    'available' => available,
    'opted_in' => optedIn,
    'closed' => closed,
    _ => unknown,
  };
}

/// Student AI for one child: open to opt in ([pricing] and [window] set), already opted in
/// ([optIn] set), or closed at the school for now.
class StudentAiOffer {
  const StudentAiOffer({
    required this.studentId,
    required this.studentName,
    required this.state,
    required this.window,
    required this.pricing,
    required this.optIn,
  });

  factory StudentAiOffer.fromJson(Map<String, Object?> json) => StudentAiOffer(
    studentId: json['studentId']! as String,
    studentName: json['studentName']! as String,
    state: StudentAiOfferState.fromJson(json['state']),
    window: _objectOrNull(json['window'], StudentAiWindow.fromJson),
    pricing: _objectOrNull(json['pricing'], StudentAiPricing.fromJson),
    optIn: _objectOrNull(json['optIn'], StudentAiOptIn.fromJson),
  );

  final String studentId;
  final String studentName;
  final StudentAiOfferState state;
  final StudentAiWindow? window;
  final StudentAiPricing? pricing;
  final StudentAiOptIn? optIn;

  /// Can be opted in now: the window is open for this child and the API priced it.
  bool get canOptIn => state == StudentAiOfferState.available && pricing != null;
}

/// The school's opt-in window for the child.
class StudentAiWindow {
  const StudentAiWindow({
    required this.id,
    required this.opensOn,
    required this.closesOn,
    required this.academicYearName,
  });

  factory StudentAiWindow.fromJson(Map<String, Object?> json) => StudentAiWindow(
    id: json['id']! as String,
    opensOn: DateTime.parse(json['opensOn']! as String),
    closesOn: DateTime.parse(json['closesOn']! as String),
    academicYearName: json['academicYearName']! as String,
  );

  final String id;
  final DateTime opensOn;
  final DateTime closesOn;
  final String academicYearName;
}

/// What opting in today costs: [monthlyPriceMinor] × [months] = [totalMinor], from [startMonth]
/// to [endMonth]. The months follow the school's academic year (a late opt-in covers only the
/// months left, starting this month); the app shows them as the API sends them.
class StudentAiPricing {
  const StudentAiPricing({
    required this.currencyCode,
    required this.minorUnit,
    required this.monthlyPriceMinor,
    required this.months,
    required this.totalMinor,
    required this.startMonth,
    required this.endMonth,
  });

  factory StudentAiPricing.fromJson(Map<String, Object?> json) => StudentAiPricing(
    currencyCode: json['currencyCode']! as String,
    minorUnit: (json['minorUnit']! as num).toInt(),
    monthlyPriceMinor: (json['monthlyPriceMinor']! as num).toInt(),
    months: (json['months']! as num).toInt(),
    totalMinor: (json['totalMinor']! as num).toInt(),
    startMonth: DateTime.parse(json['startMonth']! as String),
    endMonth: DateTime.parse(json['endMonth']! as String),
  );

  final String currencyCode;
  final int minorUnit;
  final int monthlyPriceMinor;
  final int months;
  final int totalMinor;
  final DateTime startMonth;
  final DateTime endMonth;
}

enum StudentAiOptInSource {
  parent,
  schoolOnBehalf,
  transfer,
  unknown;

  static StudentAiOptInSource fromJson(Object? value) => switch (value) {
    'parent' => parent,
    'school_on_behalf' => schoolOnBehalf,
    'transfer' => transfer,
    _ => unknown,
  };
}

enum StudentAiOptInStatus {
  active,
  released,
  transferred,
  unknown;

  static StudentAiOptInStatus fromJson(Object? value) => switch (value) {
    'active' => active,
    'released' => released,
    'transferred' => transferred,
    _ => unknown,
  };
}

/// A child's Student AI opt-in: committed for [months] months from [startMonth], [totalMinor] in
/// all, paid with tuition. [seatId] is null until the school's licence has a seat for the child.
class StudentAiOptIn {
  const StudentAiOptIn({
    required this.id,
    required this.studentId,
    required this.studentName,
    required this.source,
    required this.optedInAt,
    required this.startMonth,
    required this.endMonth,
    required this.months,
    required this.currencyCode,
    required this.minorUnit,
    required this.monthlyPriceMinor,
    required this.totalMinor,
    required this.seatId,
    required this.status,
    required this.releasedEffectiveMonth,
  });

  factory StudentAiOptIn.fromJson(Map<String, Object?> json) {
    final released = json['releasedEffectiveMonth'] as String?;
    return StudentAiOptIn(
      id: json['id']! as String,
      studentId: json['studentId']! as String,
      studentName: json['studentName']! as String,
      source: StudentAiOptInSource.fromJson(json['source']),
      optedInAt: DateTime.parse(json['optedInAt']! as String),
      startMonth: DateTime.parse(json['startMonth']! as String),
      endMonth: DateTime.parse(json['endMonth']! as String),
      months: (json['months']! as num).toInt(),
      currencyCode: json['currencyCode']! as String,
      minorUnit: (json['minorUnit']! as num).toInt(),
      monthlyPriceMinor: (json['monthlyPriceMinor']! as num).toInt(),
      totalMinor: (json['totalMinor']! as num).toInt(),
      seatId: json['seatId'] as String?,
      status: StudentAiOptInStatus.fromJson(json['status']),
      releasedEffectiveMonth: released == null ? null : DateTime.parse(released),
    );
  }

  final String id;
  final String studentId;
  final String studentName;
  final StudentAiOptInSource source;
  final DateTime optedInAt;
  final DateTime startMonth;
  final DateTime endMonth;
  final int months;
  final String currencyCode;
  final int minorUnit;
  final int monthlyPriceMinor;
  final int totalMinor;
  final String? seatId;
  final StudentAiOptInStatus status;

  /// For a released seat: the month it is no longer charged from.
  final DateTime? releasedEffectiveMonth;

  bool get isActive => status == StudentAiOptInStatus.active;

  /// Opted in, but the school's licence has no seat for the child yet.
  bool get waitingForSeat => isActive && seatId == null;
}

/// [minor] units of [currencyCode] as a price for [locale], e.g. `$6` or `$5.50`: whole amounts
/// drop the fraction, others keep the currency's [minorUnit] digits.
String formatStudentAiMoney(
  int minor, {
  required int minorUnit,
  required String currencyCode,
  required String locale,
}) {
  final scale = math.pow(10, minorUnit).toInt();
  final whole = minor % scale == 0;
  return NumberFormat.simpleCurrency(
    locale: locale,
    name: currencyCode,
    decimalDigits: whole ? 0 : minorUnit,
  ).format(minor / scale);
}

T? _objectOrNull<T>(Object? raw, T Function(Map<String, Object?>) parse) =>
    raw is Map ? parse(Map<String, Object?>.from(raw)) : null;
