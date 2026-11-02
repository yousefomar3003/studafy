// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  renderSchoolApplicationApprovedEmail,
  renderSchoolApplicationEmail,
  renderSchoolApplicationRejectedEmail,
} from "./templates";

const application = {
  applicantName: "Sara Al-Ahmad",
  applicantEmail: "sara@gmail.com",
  applicantJobTitle: "Owner",
  applicantPhone: "+966 50 123 4567",
  provider: "google",
  schoolName: "Al Noor International",
  schoolEmail: null,
  country: "Saudi Arabia",
  city: "Riyadh",
  address: "King Fahd Rd, Al Olaya",
  website: null,
  studentCount: 450,
  currency: "SAR",
  message: null,
  proofFileName: "commercial-registration.pdf",
  submittedAt: "2026-10-16T09:00:00.000Z",
  consoleUrl: "https://app.studafy.com/portal/platform/applications/abc",
};

describe("renderSchoolApplicationEmail", () => {
  test("carries every field the applicant filled in, and the console link", () => {
    const email = renderSchoolApplicationEmail(application);
    expect(email.subject).toBe(
      "New school application: Al Noor International (Riyadh, Saudi Arabia)",
    );
    for (const line of [
      "City: Riyadh",
      "Country: Saudi Arabia",
      "Address: King Fahd Rd, Al Olaya",
      "Phone: +966 50 123 4567",
      "Signed up with: Google",
      "Proof of ownership: commercial-registration.pdf",
      "Students: 450",
    ]) {
      expect(email.text).toContain(line);
    }
    expect(email.text).not.toContain("Website:");
    expect(email.text).toContain(application.consoleUrl);
  });

  test("escapes applicant-supplied content in the HTML body", () => {
    const email = renderSchoolApplicationEmail({ ...application, schoolName: "<img onerror=x>" });
    expect(email.html).not.toContain("<img onerror");
    expect(email.html).toContain("&lt;img onerror=x&gt;");
  });
});

describe("decision emails", () => {
  const decision = {
    applicantName: "Sara",
    schoolName: "Al Noor International",
    provider: "microsoft",
    actionUrl: "https://app.studafy.com/auth/login",
    reason: null,
  };

  test("approval tells the applicant to sign in with the same provider", () => {
    const email = renderSchoolApplicationApprovedEmail(decision);
    expect(email.subject).toContain("approved");
    expect(email.text).toContain("same Microsoft account");
    expect(email.text).toContain(decision.actionUrl);
  });

  test("rejection includes the reviewer's reason", () => {
    const email = renderSchoolApplicationRejectedEmail({
      ...decision,
      actionUrl: "https://app.studafy.com/signup",
      reason: "The licence document is unreadable.",
    });
    expect(email.text).toContain("Reason: The licence document is unreadable.");
    expect(email.html).toContain("Apply again");
  });
});
