// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { guessColumn, unmappedColumns } from "./unmapped";

describe("unmappedColumns", () => {
  test("lists the headers no import field or template field reads, in file order", () => {
    const headers = ["Student ID", "First", "Last", "Blood Type", "Bus stop", "Notes"];
    expect(
      unmappedColumns(headers, {
        admission_number: "student id",
        first_name: "First",
        last_name: "LAST",
        records: { "6f1e0c5a-0000-4000-8000-000000000001": "bus_stop" },
      }),
    ).toEqual([
      { position: 3, header: "Blood Type", normalized_header: "bloodtype" },
      { position: 5, header: "Notes", normalized_header: "notes" },
    ]);
  });

  test("is every header when nothing is mapped, and none when everything is", () => {
    expect(unmappedColumns(["a", "b"], {}).map((column) => column.header)).toEqual(["a", "b"]);
    expect(unmappedColumns(["a"], { first_name: "a" })).toEqual([]);
  });
});

describe("guessColumn", () => {
  test("guesses yes/no, ISO dates, numbers, emails and phones from the values", () => {
    expect(guessColumn("Allergies?", ["Yes", "no", "", "نعم"]).field_type).toBe("yes_no");
    expect(guessColumn("Joined", ["2024-09-01", "2023-01-15"]).field_type).toBe("date");
    expect(guessColumn("Siblings", ["0", "2", "3"]).field_type).toBe("number");
    expect(guessColumn("Height", ["1.42", "1.5"]).field_type).toBe("number");
    expect(guessColumn("Work email", ["a@b.co", "c@d.org"]).field_type).toBe("email");
    expect(guessColumn("Mobile", ["96550001234", "96550005678"]).field_type).toBe("phone");
    expect(guessColumn("Home", ["+965 2222 3333", "(965) 2444-5555"]).field_type).toBe("phone");
  });

  test("keeps an ambiguous day/month date as text rather than reordering it", () => {
    expect(guessColumn("Joined", ["03/04/2010", "12/01/2011"]).field_type).toBe("short_text");
  });

  test("treats a run of digits as an identifier, never a number, and suggests sensitive", () => {
    const guess = guessColumn("Ref", ["289010112345", "301020254321"]);
    expect(guess).toEqual({ field_type: "short_text", options: [], sensitive_reason: "values" });
    expect(guessColumn("Code", ["0012", "0450"]).field_type).toBe("short_text");
    expect(guessColumn("Doc", ["P1234567", "AB7654321"]).sensitive_reason).toBe("values");
  });

  test("suggests sensitive from the header: identity, medical and pay, in English and Arabic", () => {
    expect(guessColumn("Civil ID", ["x"]).sensitive_reason).toBe("label");
    expect(guessColumn("Passport number", ["x"]).sensitive_reason).toBe("label");
    expect(guessColumn("Medical conditions", ["Asthma"]).sensitive_reason).toBe("label");
    expect(guessColumn("Father salary", ["900"]).sensitive_reason).toBe("label");
    expect(guessColumn("الرقم المدني", ["1"]).sensitive_reason).toBe("label");
    expect(guessColumn("راتب الأب", ["1"]).sensitive_reason).toBe("label");
    expect(guessColumn("Bus stop", ["Gate 3"]).sensitive_reason).toBeNull();
  });

  test("a phone header is not an identifier, whatever its digits", () => {
    expect(guessColumn("Phone", ["96550001234", "96550005678"]).sensitive_reason).toBeNull();
  });

  test("offers a choice for a few repeated values, with stable unique option values", () => {
    const guess = guessColumn("House", ["Red", "Blue", "Red", "Blue", "Green", "Green", "red"]);
    expect(guess.field_type).toBe("single_choice");
    expect(guess.options.map((option) => option.label_en)).toEqual(["Blue", "Green", "Red"]);
    expect(guess.options.map((option) => option.value)).toEqual(["blue", "green", "red"]);

    const arabic = guessColumn("البيت", ["أحمر", "أزرق", "أحمر", "أزرق"]);
    expect(arabic.options.map((option) => option.value)).toEqual(["option_1", "option_2"]);
  });

  test("falls back to short or long text", () => {
    expect(guessColumn("Notes", ["one", "two", "three"]).field_type).toBe("short_text");
    expect(guessColumn("Notes", ["x".repeat(501)]).field_type).toBe("long_text");
    expect(guessColumn("Empty", ["", " "]).field_type).toBe("short_text");
  });
});
