import 'package:flutter_test/flutter_test.dart';
import 'package:studafy_mobile/src/features/parent/domain/family_finance.dart';

void main() {
  group('FamilyInvoice.fromJson', () {
    Map<String, Object?> invoiceJson({
      String? dueDate = '2026-02-01',
      String? payOnlineUrl = 'https://pay.example.com/checkout?invoice=SI-1',
      num outstandingAmountMinor = 125000,
    }) => {
          'erpnext_docname': 'SI-1',
          'erpnext_status': 'submitted',
          'issued_date': '2026-01-01',
          'due_date': dueDate,
          'total_amount': '125.000',
          'total_amount_minor': 125000,
          'outstanding_amount': (outstandingAmountMinor / 1000).toStringAsFixed(3),
          'outstanding_amount_minor': outstandingAmountMinor,
          'currency': 'JOD',
          'currency_minor_unit': 3,
          'pay_online_url': payOnlineUrl,
          'synced_at': '2026-01-02T00:00:00.000Z',
        };

    test('parses every field, including a null due date and pay-online url', () {
      final invoice = FamilyInvoice.fromJson(invoiceJson(dueDate: null, payOnlineUrl: null));

      expect(invoice.erpnextDocname, 'SI-1');
      expect(invoice.issuedDate, DateTime.parse('2026-01-01'));
      expect(invoice.dueDate, isNull);
      expect(invoice.payOnlineUrl, isNull);
      expect(invoice.currency, 'JOD');
      expect(invoice.outstandingLabel, '125.000 JOD');
    });

    test('isSettled is true only once nothing is outstanding', () {
      expect(FamilyInvoice.fromJson(invoiceJson(outstandingAmountMinor: 0)).isSettled, isTrue);
      expect(FamilyInvoice.fromJson(invoiceJson(outstandingAmountMinor: 1)).isSettled, isFalse);
    });

    test('isOverdue is true only for an unsettled invoice whose due date has passed', () {
      final overdue = FamilyInvoice.fromJson(invoiceJson(dueDate: '2020-01-01'));
      final notYetDue = FamilyInvoice.fromJson(invoiceJson(dueDate: '2099-01-01'));
      final settledPastDue =
          FamilyInvoice.fromJson(invoiceJson(dueDate: '2020-01-01', outstandingAmountMinor: 0));

      expect(overdue.isOverdue, isTrue);
      expect(notYetDue.isOverdue, isFalse);
      expect(settledPastDue.isOverdue, isFalse);
    });
  });

  group('InstallmentStatus.fromWire', () {
    test('maps every wire value to its enum case', () {
      expect(InstallmentStatus.fromWire('pending'), InstallmentStatus.pending);
      expect(InstallmentStatus.fromWire('partially_paid'), InstallmentStatus.partiallyPaid);
      expect(InstallmentStatus.fromWire('paid'), InstallmentStatus.paid);
      expect(InstallmentStatus.fromWire('overdue'), InstallmentStatus.overdue);
    });

    test('falls back to pending for an unrecognised value', () {
      expect(InstallmentStatus.fromWire('something_new'), InstallmentStatus.pending);
    });
  });

  group('ReceiptStatus.fromWire', () {
    test('maps every wire value to its enum case', () {
      expect(ReceiptStatus.fromWire('pending'), ReceiptStatus.pending);
      expect(ReceiptStatus.fromWire('confirmed'), ReceiptStatus.confirmed);
      expect(ReceiptStatus.fromWire('failed'), ReceiptStatus.failed);
    });

    test('falls back to pending for an unrecognised value', () {
      expect(ReceiptStatus.fromWire('something_new'), ReceiptStatus.pending);
    });
  });

  group('FamilyReceipt.fromJson', () {
    test('parses a bare-path receipt_url verbatim, without resolving it', () {
      final receipt = FamilyReceipt.fromJson({
        'id': 'pay-1',
        'erpnext_payment_entry_id': 'PE-1',
        'erpnext_invoice_id': 'SI-1',
        'amount': '75.000',
        'amount_minor': 75000,
        'currency': 'JOD',
        'currency_minor_unit': 3,
        'payment_mode': 'cash',
        'status': 'confirmed',
        'erpnext_status': 'submitted',
        'receipt_url': '/printview?doctype=Payment%20Entry&name=PE-1',
        'payment_date': '2026-01-15',
        'confirmed_at': '2026-01-15T10:00:00.000Z',
        'last_synced_at': '2026-01-15T10:05:00.000Z',
      });

      expect(receipt.receiptUrl, '/printview?doctype=Payment%20Entry&name=PE-1');
      expect(receipt.amountLabel, '75.000 JOD');
      expect(receipt.status, ReceiptStatus.confirmed);
      expect(receipt.paymentDate, DateTime.parse('2026-01-15'));
    });

    test('receipt_url is null when the payment cache has none yet', () {
      final receipt = FamilyReceipt.fromJson({
        'id': 'pay-2',
        'erpnext_payment_entry_id': null,
        'erpnext_invoice_id': null,
        'amount': '10.000',
        'amount_minor': 10000,
        'currency': 'JOD',
        'currency_minor_unit': 3,
        'payment_mode': null,
        'status': 'pending',
        'erpnext_status': 'draft',
        'receipt_url': null,
        'payment_date': '2026-01-15',
        'confirmed_at': null,
        'last_synced_at': '2026-01-15T10:05:00.000Z',
      });

      expect(receipt.receiptUrl, isNull);
    });
  });

  group('FamilyFinanceView', () {
    FamilyStudentFinance section(String studentId, {List<MoneyTotal> totals = const []}) =>
        FamilyStudentFinance(
          studentId: studentId,
          invoices: const [],
          installments: const [],
          receipts: const [],
          totals: totals,
        );

    test('sectionFor finds a linked child and returns null for one the view knows nothing about',
        () {
      final view = FamilyFinanceView(
        sections: [section('child-1')],
        householdTotals: const [],
        dataAsOf: null,
      );

      expect(view.sectionFor('child-1'), isNotNull);
      expect(view.sectionFor('child-2'), isNull);
    });

    test('amountsDueFor drops settled currencies and an unknown child alike', () {
      final owed = MoneyTotal(currency: 'JOD', outstandingAmount: '10.000', outstandingMinor: 10000);
      final settled = MoneyTotal(currency: 'USD', outstandingAmount: '0.00', outstandingMinor: 0);
      final view = FamilyFinanceView(
        sections: [section('child-1', totals: [owed, settled])],
        householdTotals: const [],
        dataAsOf: null,
      );

      expect(view.amountsDueFor('child-1'), [owed]);
      expect(view.amountsDueFor('child-2'), isEmpty);
    });
  });
}
