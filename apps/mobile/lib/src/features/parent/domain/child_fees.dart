/// One currency's outstanding balance for a child or a household.
///
/// [outstandingAmount] is the decimal string the API already formatted to the currency's own
/// precision (e.g. `"125.000"` for JOD); it is shown verbatim so no client-side currency maths
/// is needed. [outstandingMinor] backs the "is anything actually owed?" check so that never
/// hinges on parsing the string.
class MoneyTotal {
  const MoneyTotal({
    required this.currency,
    required this.outstandingAmount,
    required this.outstandingMinor,
  });

  factory MoneyTotal.fromJson(Map<String, Object?> json) => MoneyTotal(
        currency: json['currency']! as String,
        outstandingAmount: json['outstanding_amount']! as String,
        outstandingMinor: (json['outstanding_amount_minor']! as num).toInt(),
      );

  final String currency;
  final String outstandingAmount;
  final int outstandingMinor;

  bool get owesMoney => outstandingMinor > 0;

  /// e.g. `"125.000 JOD"`.
  String get label => '$outstandingAmount $currency';
}

/// The parent-home slice of `GET /api/finance/families/{familyId}`: what each child still owes
/// and the household total. The response's invoice, installment and receipt arrays are dropped
/// on the way in — the home screen only needs the outstanding figure.
class FamilyFinanceView {
  const FamilyFinanceView({
    required this.outstandingByStudentId,
    required this.householdTotals,
    required this.dataAsOf,
  });

  final Map<String, List<MoneyTotal>> outstandingByStudentId;
  final List<MoneyTotal> householdTotals;

  /// Most recent cache sync behind these figures; null when the household has no finance data.
  final DateTime? dataAsOf;

  /// The currencies [studentId] still owes on. Empty when the child is settled, or when the
  /// finance view knows nothing about them.
  List<MoneyTotal> amountsDueFor(String studentId) => [
        for (final total in outstandingByStudentId[studentId] ?? const <MoneyTotal>[])
          if (total.owesMoney) total,
      ];
}
