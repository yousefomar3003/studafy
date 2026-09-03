/// e.g. `"125.000 JOD"` — the decimal string an amount was already formatted to, followed by its
/// currency code.
String moneyLabel(String amount, String currency) => '$amount $currency';

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

  String get label => moneyLabel(outstandingAmount, currency);
}

/// One ERPNext Sales Invoice against a child, as `GET /api/finance/families/{familyId}` reports
/// it. There is no separate "paid" vs "unpaid" enum on the wire — [isSettled] (derived from
/// [outstandingMinor]) and [isOverdue] (derived from [dueDate]) are this client's own reading of
/// the same fields the family finance card already uses, not a status the API hands down.
class FamilyInvoice {
  const FamilyInvoice({
    required this.erpnextDocname,
    required this.issuedDate,
    required this.dueDate,
    required this.totalAmount,
    required this.outstandingAmount,
    required this.outstandingMinor,
    required this.currency,
    required this.payOnlineUrl,
  });

  factory FamilyInvoice.fromJson(Map<String, Object?> json) => FamilyInvoice(
        erpnextDocname: json['erpnext_docname']! as String,
        issuedDate: DateTime.parse(json['issued_date']! as String),
        dueDate: json['due_date'] == null ? null : DateTime.parse(json['due_date']! as String),
        totalAmount: json['total_amount']! as String,
        outstandingAmount: json['outstanding_amount']! as String,
        outstandingMinor: (json['outstanding_amount_minor']! as num).toInt(),
        currency: json['currency']! as String,
        payOnlineUrl: json['pay_online_url'] as String?,
      );

  final String erpnextDocname;
  final DateTime issuedDate;
  final DateTime? dueDate;
  final String totalAmount;
  final String outstandingAmount;
  final int outstandingMinor;
  final String currency;

  /// The pay-online redirect target, carrying this invoice and its student as query context.
  /// Null when the invoice is already settled or the school has no payment redirect configured
  /// — see `buildPayOnlineUrl` in `finance/family/service.ts`.
  final String? payOnlineUrl;

  bool get isSettled => outstandingMinor <= 0;

  bool get isOverdue =>
      !isSettled && dueDate != null && dueDate!.isBefore(DateTime.now());

  String get totalLabel => moneyLabel(totalAmount, currency);
  String get outstandingLabel => moneyLabel(outstandingAmount, currency);
}

/// A fee-schedule installment's payment state, mirroring the closed set
/// `finance/family/schemas.ts`'s `installmentSummarySchema` validates server-side.
enum InstallmentStatus {
  pending,
  partiallyPaid,
  paid,
  overdue;

  /// Falls back to [pending] for a wire value newer than this build recognises — this client is
  /// hand-parsed (the `Finance` OpenAPI tag is excluded from codegen, see
  /// `family_finance_client.dart`), so there is no generated `$unknown` case to lean on.
  static InstallmentStatus fromWire(String value) => switch (value) {
        'pending' => InstallmentStatus.pending,
        'partially_paid' => InstallmentStatus.partiallyPaid,
        'paid' => InstallmentStatus.paid,
        'overdue' => InstallmentStatus.overdue,
        _ => InstallmentStatus.pending,
      };
}

/// One fee-schedule installment against a child.
class FamilyInstallment {
  const FamilyInstallment({
    required this.erpnextFeeScheduleId,
    required this.dueDate,
    required this.totalAmount,
    required this.outstandingAmount,
    required this.currency,
    required this.status,
  });

  factory FamilyInstallment.fromJson(Map<String, Object?> json) => FamilyInstallment(
        erpnextFeeScheduleId: json['erpnext_fee_schedule_id']! as String,
        dueDate: DateTime.parse(json['due_date']! as String),
        totalAmount: json['total_amount']! as String,
        outstandingAmount: json['outstanding_amount']! as String,
        currency: json['currency']! as String,
        status: InstallmentStatus.fromWire(json['status']! as String),
      );

  final String erpnextFeeScheduleId;
  final DateTime dueDate;
  final String totalAmount;
  final String outstandingAmount;
  final String currency;
  final InstallmentStatus status;

  String get totalLabel => moneyLabel(totalAmount, currency);
  String get outstandingLabel => moneyLabel(outstandingAmount, currency);
}

/// A payment's confirmation state, mirroring `paymentSummarySchema`'s `status` enum.
enum ReceiptStatus {
  pending,
  confirmed,
  failed;

  /// Falls back to [pending] for a wire value newer than this build recognises — see
  /// [InstallmentStatus.fromWire] for why this client needs its own fallback.
  static ReceiptStatus fromWire(String value) => switch (value) {
        'pending' => ReceiptStatus.pending,
        'confirmed' => ReceiptStatus.confirmed,
        'failed' => ReceiptStatus.failed,
        _ => ReceiptStatus.pending,
      };
}

/// One payment record against a child — shown to parents as a receipt.
class FamilyReceipt {
  const FamilyReceipt({
    required this.id,
    required this.amount,
    required this.currency,
    required this.status,
    required this.receiptUrl,
    required this.paymentDate,
  });

  factory FamilyReceipt.fromJson(Map<String, Object?> json) => FamilyReceipt(
        id: json['id']! as String,
        amount: json['amount']! as String,
        currency: json['currency']! as String,
        status: ReceiptStatus.fromWire(json['status']! as String),
        receiptUrl: json['receipt_url'] as String?,
        paymentDate: DateTime.parse(json['payment_date']! as String),
      );

  final String id;
  final String amount;
  final String currency;
  final ReceiptStatus status;

  /// ERPNext's own link for this payment's printable receipt — an absolute URL when the payment
  /// webhook supplied one, otherwise a bare path (`receiptUrlFor` in
  /// `finance/payments/projection.ts`), deliberately not rooted to an origin because the
  /// tenant's ERPNext site is chosen by the request's Host header, not a stored URL. A bare-path
  /// receipt has nothing for this client to resolve against and surfaces through
  /// `receiptFileProvider`'s normal error/retry state — the same gap the web app's plain
  /// `<a href={receipt_url}>` (`PaymentsListPage.tsx`) has today.
  final String? receiptUrl;
  final DateTime paymentDate;

  String get amountLabel => moneyLabel(amount, currency);
}

/// One linked child's full finance detail, as the family financial view scopes it.
class FamilyStudentFinance {
  const FamilyStudentFinance({
    required this.studentId,
    required this.invoices,
    required this.installments,
    required this.receipts,
    required this.totals,
  });

  final String studentId;
  final List<FamilyInvoice> invoices;
  final List<FamilyInstallment> installments;
  final List<FamilyReceipt> receipts;
  final List<MoneyTotal> totals;

  bool get isEmpty => invoices.isEmpty && installments.isEmpty && receipts.isEmpty;
}

/// The parent-facing slice of `GET /api/finance/families/{familyId}`: read-only per
/// architecture — invoices, fee-schedule installments and payment receipts for every linked
/// child, plus the household total.
class FamilyFinanceView {
  const FamilyFinanceView({
    required this.sections,
    required this.householdTotals,
    required this.dataAsOf,
  });

  final List<FamilyStudentFinance> sections;
  final List<MoneyTotal> householdTotals;

  /// Most recent cache sync behind these figures; null when the household has no finance data.
  final DateTime? dataAsOf;

  /// [studentId]'s finance detail, or null when the view knows nothing about them (not linked,
  /// or linked but with no cached finance rows at all).
  FamilyStudentFinance? sectionFor(String studentId) {
    for (final section in sections) {
      if (section.studentId == studentId) return section;
    }
    return null;
  }

  /// The currencies [studentId] still owes on. Empty when the child is settled, or when the
  /// finance view knows nothing about them.
  List<MoneyTotal> amountsDueFor(String studentId) => [
        for (final total in sectionFor(studentId)?.totals ?? const <MoneyTotal>[])
          if (total.owesMoney) total,
      ];
}
