// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { renderSalesInquiryEmail } from "./templates";

const base = {
  fullName: "Sara Al-Ahmad",
  email: "sara@school.example",
  phone: null,
  schoolName: "Al Noor International",
  jobTitle: "Principal",
  country: null,
  studentCount: 450,
  message: null,
  sourcePath: "/pricing",
  submittedAt: "2026-10-08T09:00:00.000Z",
  consoleUrl: "https://app.studafy.com/portal/platform/inquiries",
};

describe("renderSalesInquiryEmail", () => {
  test("names the school and contact in the subject and lists only the fields given", () => {
    const email = renderSalesInquiryEmail(base);
    expect(email.subject).toBe("New inquiry: Al Noor International (Sara Al-Ahmad)");
    expect(email.text).toContain("Role: Principal");
    expect(email.text).toContain("Students: 450");
    expect(email.text).not.toContain("Phone:");
    expect(email.text).toContain(base.consoleUrl);
  });

  test("escapes visitor-supplied content in the HTML body", () => {
    const email = renderSalesInquiryEmail({
      ...base,
      schoolName: "<script>alert(1)</script>",
      message: 'Hi "team" & <b>friends</b>',
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("&quot;team&quot; &amp; &lt;b&gt;");
  });
});
