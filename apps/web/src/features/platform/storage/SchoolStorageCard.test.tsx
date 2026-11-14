import { ToastProvider } from "@studafy/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

/**
 * The storage add-on on the console's school page: the plan and any change scheduled for renewal,
 * every invoice with what it took and what was refunded, the overcharges refunded automatically, and
 * a refund of one invoice -- never more than is left, with a reason, sent once.
 */

const SCHOOL_ID = "11111111-1111-4111-8111-111111111111";
const GIB = 1024 ** 3;

const STORAGE = {
  subscription: {
    planCode: "storage_1tb",
    capBytes: 1024 * GIB,
    status: "active",
    price: {
      id: "22222222-2222-4222-8222-222222222222",
      amountMinor: 4900,
      currency: "USD",
      interval: "monthly",
    },
    currentPeriodEnd: "2026-12-14T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    stripeSubscriptionId: "sub_test_school",
    pendingChange: {
      planCode: "storage_100gb",
      capBytes: 100 * GIB,
      price: null,
      effectiveAt: "2026-12-14T00:00:00.000Z",
    },
  },
  billing: {
    paymentMethod: { brand: "visa", last4: "4242", expMonth: 3, expYear: 2029 },
    nextBill: { amountMinor: 1000, currency: "USD", at: "2026-12-14T00:00:00.000Z" },
    invoices: [
      {
        id: "in_upgrade",
        number: "S-2",
        status: "paid",
        created: "2026-11-14T17:41:00.000Z",
        amountDueMinor: 3862,
        amountPaidMinor: 3862,
        amountRefundedMinor: 0,
        currency: "USD",
        billingReason: "subscription_update",
        hostedInvoiceUrl: "https://invoice.example/in_upgrade",
        invoicePdf: null,
      },
    ],
  },
  billingError: null,
  incidents: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      stripeInvoiceId: "in_upgrade",
      expectedMinor: 0,
      chargedMinor: 3862,
      refundMinor: 3862,
      currency: "USD",
      stripeRefundId: "re_1",
      status: "refunded",
      lastError: null,
      createdAt: "2026-11-14T17:41:00.000Z",
    },
  ],
};

const getMock = mock(() => Promise.resolve({ data: STORAGE }));
const postMock = mock(() =>
  Promise.resolve({ data: { refundId: "re_2", status: "succeeded", amountMinor: 1000 } }),
);
mock.module("../../../lib/api", () => ({ api: { GET: getMock, POST: postMock } }));

async function renderCard() {
  const { SchoolStorageCard } = await import("./SchoolStorageCard");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <SchoolStorageCard schoolId={SCHOOL_ID} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockClear();
  postMock.mockClear();
});

describe("SchoolStorageCard", () => {
  test("shows the plan, the scheduled change, the invoices and the overcharge refunded", async () => {
    await renderCard();

    expect(await screen.findByText(/Scheduled: changes to 100 GB on/)).toBeTruthy();
    expect(screen.getByText("sub_test_school")).toBeTruthy();
    expect(screen.getByText("Paid with visa ending in 4242")).toBeTruthy();
    expect(screen.getByText(/charged \$38\.62 instead of \$0\.00; \$38\.62 refunded/)).toBeTruthy();
    const table = screen.getByRole("table", { name: "Invoices" });
    expect(within(table).getByText("subscription_update")).toBeTruthy();
  });

  test("a refund needs a reason, is capped at what is left, and is sent once", async () => {
    await renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Refund" }));
    const dialog = await screen.findByRole("dialog", { name: "Refund a storage invoice" });
    const amount = within(dialog).getByLabelText("Amount (USD)");
    expect((amount as HTMLInputElement).value).toBe("38.62");

    fireEvent.change(amount, { target: { value: "50.00" } });
    expect(within(dialog).getByText(/no more than what can still be refunded/)).toBeTruthy();

    fireEvent.change(amount, { target: { value: "10.00" } });
    const confirm = within(dialog).getByRole("button", {
      name: "Refund $10.00",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("Reason (kept in the audit log)"), {
      target: { value: "Charged twice on 14 November" },
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0] as unknown as [
      string,
      { params: { path: { invoiceId: string } }; body: Record<string, unknown> },
    ];
    expect(path).toBe(
      "/api/platform/schools/{schoolId}/storage-subscription/invoices/{invoiceId}/refund",
    );
    expect(init.params.path.invoiceId).toBe("in_upgrade");
    expect(init.body).toMatchObject({ amountMinor: 1000, reason: "Charged twice on 14 November" });
    expect(typeof init.body.requestKey).toBe("string");
  });
});
