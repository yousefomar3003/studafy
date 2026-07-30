// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";
import { validateXML } from "xmllint-wasm";

import {
  generateJoInvoice,
  JoInvoiceValidationError,
  normalizeErpNextReport,
  reportToCsv,
  type JoInvoiceInput,
} from "./index";

const invoice: JoInvoiceInput = {
  schoolId: "5f417184-d876-4e6a-88cb-9fd589141b54",
  invoiceId: "ACC-SINV-2026-0001",
  issueDate: "2026-07-30",
  currency: "JOD",
  supplier: { name: "Studafy & School", taxId: "123456", address: "Amman <JO>" },
  customer: { name: 'Parent "One"', taxId: "987654", address: "Zarqa" },
  lines: [
    {
      id: "1",
      description: "Tuition & activities",
      quantity: 1,
      unitPrice: 100,
      lineExtensionAmount: 100,
    },
  ],
  taxAmount: 16,
  taxExclusiveAmount: 100,
  taxInclusiveAmount: 116,
  payableAmount: 116,
};

const UBL_COMMON_SCHEMAS = [
  "CCTS_CCT_SchemaModule-2.1.xsd",
  "UBL-CommonAggregateComponents-2.1.xsd",
  "UBL-CommonBasicComponents-2.1.xsd",
  "UBL-CommonExtensionComponents-2.1.xsd",
  "UBL-CommonSignatureComponents-2.1.xsd",
  "UBL-CoreComponentParameters-2.1.xsd",
  "UBL-ExtensionContentDataType-2.1.xsd",
  "UBL-QualifiedDataTypes-2.1.xsd",
  "UBL-SignatureAggregateComponents-2.1.xsd",
  "UBL-SignatureBasicComponents-2.1.xsd",
  "UBL-UnqualifiedDataTypes-2.1.xsd",
  "UBL-XAdESv132-2.1.xsd",
  "UBL-XAdESv141-2.1.xsd",
  "UBL-xmldsig-core-schema-2.1.xsd",
] as const;

function ublFixture(path: string): Bun.BunFile {
  return Bun.file(new URL(`../test-fixtures/ubl-2.1/${path}`, import.meta.url));
}

describe("ERPNext report shaping", () => {
  test("preserves columns, rows, and summaries without calculating values", () => {
    const source = {
      message: {
        columns: [{ fieldname: "outstanding", fieldtype: "Currency" }],
        result: [{ outstanding: 12.3456, bucket: "30" }],
        report_summary: [{ label: "Outstanding", value: 12.3456 }],
      },
    };
    const normalized = normalizeErpNextReport(source);
    expect(normalized.columns).toEqual(source.message.columns);
    expect(normalized.rows).toEqual(source.message.result);
    expect(normalized.reportSummary).toEqual(source.message.report_summary);
  });

  test("writes a BOM and RFC-compliant CSV escaping", () => {
    const bytes = reportToCsv({
      columns: [{ fieldname: "name", label: "Name" }],
      rows: [{ name: 'Family, "A"\nSecond line' }],
      reportSummary: [],
    });
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toBe('Name\r\n"Family, ""A""\nSecond line"\r\n');
  });
});

describe("JoInvoice generation", () => {
  test("is deterministic, escapes XML, and round-trips the JSON envelope", () => {
    const first = generateJoInvoice(invoice);
    const second = generateJoInvoice(invoice);
    expect(second.uuid).toBe(first.uuid);
    expect(second.hash).toBe(first.hash);
    expect(first.xml).toContain("Studafy &amp; School");
    expect(first.xml).toContain("Amman &lt;JO&gt;");
    expect(Buffer.from(first.jsonEnvelope.invoice, "base64").toString("utf8")).toBe(first.xml);
  });

  test("changes the hash when authoritative invoice content changes", () => {
    const first = generateJoInvoice(invoice);
    const changed = generateJoInvoice({ ...invoice, payableAmount: 117 });
    expect(changed.uuid).toBe(first.uuid);
    expect(changed.hash).not.toBe(first.hash);
  });

  test("validates against the vendored official OASIS UBL 2.1 XSD set", async () => {
    const schemaName = "UBL-Invoice-2.1.xsd";
    const preload = await Promise.all(
      UBL_COMMON_SCHEMAS.map(async (fileName) => ({
        fileName,
        contents: await ublFixture(`common/${fileName}`).text(),
      })),
    );
    const validation = await validateXML({
      xml: { fileName: "joinvoice.xml", contents: generateJoInvoice(invoice).xml },
      schema: {
        fileName: schemaName,
        contents: (await ublFixture(`maindoc/${schemaName}`).text()).replaceAll("../common/", ""),
      },
      preload,
      maxMemoryPages: 1024,
    });

    expect(validation.errors.map((error) => error.message)).toEqual([]);
    expect(validation.valid).toBe(true);
  }, 30_000);

  test("rejects missing mandatory compliance data", () => {
    expect(() =>
      generateJoInvoice({
        ...invoice,
        supplier: { ...invoice.supplier, taxId: "" },
      }),
    ).toThrow(JoInvoiceValidationError);
  });
});
