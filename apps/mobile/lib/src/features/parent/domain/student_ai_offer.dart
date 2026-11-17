/// Student AI for one school's children, as the parent sees it (`GET /api/parent/student-ai`).
///
/// The school offers Student AI as part of its fees and tells parents the price itself: the API
/// sends no price, total or amount for the parent, and the app shows none (store rules: a digital
/// service sold outside in-app purchase is never priced in the app).
///
/// Hand-parsed rather than the generated `ParentAiOffers`: the generated model types an offer's
/// `window`, `period` and `optIn` as non-null, but the API sends null for each of them in ordinary
/// states (no window yet, already opted in), so the generated `fromJson` would throw on a closed
/// offer.
class StudentAiOffers {
  const StudentAiOffers({
    required this.offers,
    required this.termsVersion,
    this.schoolName,
  });

  factory StudentAiOffers.fromJson(Map<String, Object?> json) {
    final school = (json['schoolName'] as String?)?.trim();
    return StudentAiOffers(
      offers: [
        for (final entry in (json['offers'] as List<Object?>?) ?? const [])
          StudentAiOffer.fromJson(Map<String, Object?>.from(entry! as Map)),
      ],
      termsVersion: json['termsVersion']! as String,
      schoolName: school == null || school.isEmpty ? null : school,
    );
  }

  /// One per child the school offered Student AI to. Children it never offered it to are not
  /// listed, so an empty list means there is nothing to show.
  final List<StudentAiOffer> offers;

  /// The school offering it (this account's school); null when the API didn't name it.
  final String? schoolName;

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

/// Student AI for one child: open to join ([period] and [window] set), already joined ([optIn]
/// set), or closed at the school for now.
class StudentAiOffer {
  const StudentAiOffer({
    required this.studentId,
    required this.studentName,
    required this.state,
    required this.window,
    required this.period,
    required this.optIn,
  });

  factory StudentAiOffer.fromJson(Map<String, Object?> json) => StudentAiOffer(
    studentId: json['studentId']! as String,
    studentName: json['studentName']! as String,
    state: StudentAiOfferState.fromJson(json['state']),
    window: _objectOrNull(json['window'], StudentAiWindow.fromJson),
    period: _objectOrNull(json['period'], StudentAiPeriod.fromJson),
    optIn: _objectOrNull(json['optIn'], StudentAiOptIn.fromJson),
  );

  final String studentId;
  final String studentName;
  final StudentAiOfferState state;
  final StudentAiWindow? window;
  final StudentAiPeriod? period;
  final StudentAiOptIn? optIn;

  /// Can be joined now: the window is open for this child and the API says which months it covers.
  bool get canOptIn => state == StudentAiOfferState.available && period != null;
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

/// The months joining today covers, from [startMonth] to [endMonth]: they follow the school's
/// academic year (joining late covers only the months left, starting this month).
class StudentAiPeriod {
  const StudentAiPeriod({required this.startMonth, required this.endMonth});

  factory StudentAiPeriod.fromJson(Map<String, Object?> json) => StudentAiPeriod(
    startMonth: DateTime.parse(json['startMonth']! as String),
    endMonth: DateTime.parse(json['endMonth']! as String),
  );

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

/// A child's Student AI: joined from [startMonth] to [endMonth], committed for the school year and
/// part of the school fees. [waitingForSchool] until the school's licence has a place for the child.
class StudentAiOptIn {
  const StudentAiOptIn({
    required this.id,
    required this.studentId,
    required this.studentName,
    required this.source,
    required this.optedInAt,
    required this.startMonth,
    required this.endMonth,
    required this.status,
    required this.waitingForSchool,
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
      status: StudentAiOptInStatus.fromJson(json['status']),
      waitingForSchool: json['waitingForSchool'] as bool? ?? false,
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
  final StudentAiOptInStatus status;
  final bool waitingForSchool;

  /// Once stopped: the first month it no longer runs.
  final DateTime? releasedEffectiveMonth;

  bool get isActive => status == StudentAiOptInStatus.active;

  /// Joined, but the school's licence has no place for the child yet.
  bool get waitingForSeat => isActive && waitingForSchool;
}

T? _objectOrNull<T>(Object? raw, T Function(Map<String, Object?>) parse) =>
    raw is Map ? parse(Map<String, Object?>.from(raw)) : null;
