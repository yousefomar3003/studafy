import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, describe, expect, mock, test } from "bun:test";
import { forwardRef, useEffect } from "react";

import type { ComponentType } from "react";

/**
 * "Talk to us": a phone number is required, and has to look like one, before anything is sent.
 * The Turnstile widget is replaced by one that passes at once (its script does not load in
 * happy-dom).
 */

interface RequestInit {
  body?: Record<string, unknown>;
}

const postMock = mock((_path: string, _init?: RequestInit) =>
  Promise.resolve<unknown>({ data: { message: "ok" } }),
);
mock.module("../../lib/api", () => ({ api: { POST: postMock } }));
mock.module("../../components/TurnstileWidget", () => ({
  TurnstileWidget: forwardRef(function PassingTurnstile({
    onToken,
  }: {
    onToken: (token: string) => void;
  }) {
    useEffect(() => onToken("test-token"), [onToken]);
    return null;
  }),
}));

const loadForm = async () => (await import("./ContactForm")).ContactForm as ComponentType;

async function fillAndSend(phone: string) {
  const ContactForm = await loadForm();
  render(<ContactForm />);
  fireEvent.change(screen.getByLabelText(/Full name/), { target: { value: "Sara Al-Ahmad" } });
  fireEvent.change(screen.getByLabelText(/Work email/), {
    target: { value: "sara@school.example" },
  });
  fireEvent.change(screen.getByLabelText(/School name/), {
    target: { value: "Al Noor International" },
  });
  fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: phone } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

afterEach(() => {
  cleanup();
  postMock.mockClear();
});

describe("Talk to us: the phone number", () => {
  test("is required: nothing is sent without one", async () => {
    await fillAndSend("");
    expect(
      await screen.findByText("Enter a phone number, with the country code if you have one."),
    ).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/^Phone/) as HTMLInputElement).required).toBe(true);
  });

  test("must look like a phone number", async () => {
    await fillAndSend("call me");
    expect(
      await screen.findByText("Enter a phone number, with the country code if you have one."),
    ).toBeTruthy();
    expect(postMock).not.toHaveBeenCalled();
  });

  test("is sent as typed once it is one", async () => {
    await fillAndSend("+962 7 9123 4567");
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [path, init] = postMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/inquiries");
    expect(init.body).toMatchObject({ phone: "+962 7 9123 4567", captcha_token: "test-token" });
  });
});
