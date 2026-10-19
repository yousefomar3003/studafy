// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { decodeHtmlEntities } from "./labels";

describe("decodeHtmlEntities", () => {
  test("decodes the sanitizer's named and numeric entities", () => {
    expect(decodeHtmlEntities("a &amp; b &lt;i&gt; &quot;q&quot; &apos;s&#39; &#x27;x&#X27;")).toBe(
      "a & b <i> \"q\" 's' 'x'",
    );
    expect(decodeHtmlEntities("&#128512;")).toBe("😀");
  });

  test("decodes in a single pass, so a double-escaped entity stays literal", () => {
    expect(decodeHtmlEntities("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
  });

  test("leaves unknown or invalid references alone", () => {
    expect(decodeHtmlEntities("&copy; &#xD800; &#99999999; & plain")).toBe(
      "&copy; &#xD800; &#99999999; & plain",
    );
    expect(decodeHtmlEntities("no entities")).toBe("no entities");
  });
});
