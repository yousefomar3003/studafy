/// How a payment was collected. Mirrors the API's `PaymentMode` enum
/// (`apps/api/src/modules/finance/payments/schemas.ts`) plus `unknown` for a value this build
/// doesn't recognize yet — forward-compatible, not an error.
enum FinancePaymentMode {
  cash,
  bankTransfer,
  cardExternal,
  unknown;

  static FinancePaymentMode fromJson(String? json) => switch (json) {
    'cash' => FinancePaymentMode.cash,
    'bank_transfer' => FinancePaymentMode.bankTransfer,
    'card_external' => FinancePaymentMode.cardExternal,
    _ => FinancePaymentMode.unknown,
  };
}

/// Mirrors the API's `PaymentStatus` enum. `pending` awaits ERPNext's submission webhook;
/// `confirmed` has a receipt; `failed` was ultimately rejected or cancelled.
enum FinancePaymentStatus {
  pending,
  confirmed,
  failed,
  unknown;

  static FinancePaymentStatus fromJson(String json) => switch (json) {
    'pending' => FinancePaymentStatus.pending,
    'confirmed' => FinancePaymentStatus.confirmed,
    'failed' => FinancePaymentStatus.failed,
    _ => FinancePaymentStatus.unknown,
  };
}

/// One row of `GET /api/finance/payments` — only the fields the recent-payments summary renders.
/// Not the generated `Payment` model because there isn't one: the whole `Finance` tag is excluded
/// from mobile codegen (see `FinancePaymentsClient`).
class FinancePayment {
  const FinancePayment({
    required this.id,
    required this.amount,
    required this.currency,
    required this.paymentMode,
    required this.paymentDate,
    required this.status,
  });

  factory FinancePayment.fromJson(Map<String, Object?> json) => FinancePayment(
    id: json['id']! as String,
    // Decimal string at the currency's own precision (e.g. "125.500" for JOD) — rendered
    // verbatim, never re-parsed as a double, the same rule the web dashboard follows.
    amount: json['amount']! as String,
    currency: json['currency']! as String,
    paymentMode: FinancePaymentMode.fromJson(json['payment_mode'] as String?),
    paymentDate: json['payment_date']! as String,
    status: FinancePaymentStatus.fromJson(json['status']! as String),
  );

  final String id;
  final String amount;
  final String currency;

  /// [FinancePaymentMode.unknown] for a payment projected from ERPNext that this gateway did not
  /// forward — the API itself returns `null` for that case.
  final FinancePaymentMode paymentMode;

  /// ERPNext posting date, `YYYY-MM-DD`.
  final String paymentDate;
  final FinancePaymentStatus status;
}
