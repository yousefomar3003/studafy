const RAW_HTML_PROPERTIES = new Set(["innerHTML", "outerHTML"]);
const DOCUMENT_WRITE_METHODS = new Set(["write", "writeln"]);

/**
 * ST-296 render guard: escape-by-default is the product's whole client-side XSS defense (see
 * docs/security/content_sanitization_policy.md) — nothing in `apps/web` renders announcement,
 * comment, or AI-answer text as HTML today, on purpose. This rule keeps it that way by banning the
 * three ways a component could start doing so, so the guarantee stays a property of the codebase
 * instead of a fact someone remembered to check in review.
 *
 * `dangerouslySetInnerHTML` is React's own escape hatch, named for exactly this reason.
 * `.innerHTML`/`.outerHTML` assignment is the vanilla-DOM equivalent a non-React file could reach
 * for. `document.write`/`writeln` is the legacy third path. All three take a string straight to the
 * parser with no sanitization step in between.
 *
 * This is a blunt, syntax-level ban — it does not try to prove the string is untrusted, the same
 * way `no-session-set` does not try to prove a query runs on a pooled connection. A file with a
 * genuine, reviewed need (the one sanitizer this ticket ships, if it ever grows a rich-text profile)
 * disables the rule inline with a comment saying why, which is far cheaper than a rule that tries to
 * be clever about trust and gets it wrong.
 */

/** @type {import('eslint').Rule.RuleModule} */
const noUnsafeHtmlRender = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban dangerouslySetInnerHTML, innerHTML/outerHTML assignment, and document.write — unsanitized HTML renders.",
    },
    messages: {
      dangerouslySetInnerHTML:
        "dangerouslySetInnerHTML bypasses React's escaping. Render text as a child instead, or route it through apps/api's sanitizer + a reviewed allowlist if this is genuinely rich content.",
      rawHtmlAssignment:
        "Assigning .{{property}} injects unsanitized HTML. Use .textContent, or a React child, instead.",
      documentWrite:
        "document.{{method}} injects unsanitized HTML into the page. Use DOM APIs that treat the string as text.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "dangerouslySetInnerHTML") {
          context.report({ node, messageId: "dangerouslySetInnerHTML" });
        }
      },
      AssignmentExpression(node) {
        if (
          node.left.type === "MemberExpression" &&
          !node.left.computed &&
          node.left.property.type === "Identifier" &&
          RAW_HTML_PROPERTIES.has(node.left.property.name)
        ) {
          context.report({
            node: node.left,
            messageId: "rawHtmlAssignment",
            data: { property: node.left.property.name },
          });
        }
      },
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.computed ||
          node.callee.property.type !== "Identifier" ||
          !DOCUMENT_WRITE_METHODS.has(node.callee.property.name)
        ) {
          return;
        }
        const { object } = node.callee;
        if (object.type === "Identifier" && object.name === "document") {
          context.report({
            node,
            messageId: "documentWrite",
            data: { method: node.callee.property.name },
          });
        }
      },
    };
  },
};

export default noUnsafeHtmlRender;
