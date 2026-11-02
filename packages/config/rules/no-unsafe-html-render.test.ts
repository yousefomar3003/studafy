// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, it } from "bun:test";
import { RuleTester } from "eslint";

import noUnsafeHtmlRender from "./no-unsafe-html-render.js";

// RuleTester drives its own describe/it blocks (Mocha-shaped by default); pointing it at bun:test's
// globals is the documented way to run it under a non-Mocha framework.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("no-unsafe-html-render", noUnsafeHtmlRender, {
  valid: [
    "const el = <div>{announcement.body}</div>;",
    "node.textContent = value;",
    "el.innerText = value;",
    "logger.write(value);",
    "someOtherDocument.write(value);",
    "const html = buildHtmlString();", // constructing a string is fine; rendering it raw is not
  ],
  invalid: [
    {
      code: "const el = <div dangerouslySetInnerHTML={{ __html: body }} />;",
      errors: [{ messageId: "dangerouslySetInnerHTML" }],
    },
    {
      code: "node.innerHTML = body;",
      errors: [{ messageId: "rawHtmlAssignment", data: { property: "innerHTML" } }],
    },
    {
      code: "node.outerHTML = body;",
      errors: [{ messageId: "rawHtmlAssignment", data: { property: "outerHTML" } }],
    },
    {
      code: "document.write(body);",
      errors: [{ messageId: "documentWrite", data: { method: "write" } }],
    },
    {
      code: "document.writeln(body);",
      errors: [{ messageId: "documentWrite", data: { method: "writeln" } }],
    },
  ],
});
