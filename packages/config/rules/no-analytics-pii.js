/**
 * Word roots that mark a field as personal data. A key/reference is flagged when one of its
 * snake_case or camelCase segments exactly equals one of these — so `admin_email`, `schoolEmail`,
 * and `email` all match on the `email` segment, while an unrelated field like `emailed_at` does not
 * (its segments are `emailed`/`at`, neither of which is a root). A short list of compound words with
 * no natural segment boundary (`username`, `apikey`, ...) is checked as a whole-string fallback.
 */
const PII_ROOTS = new Set([
  "email",
  "mail",
  "phone",
  "mobile",
  "address",
  "ssn",
  "password",
  "passwd",
  "secret",
  "token",
  "ip",
  "dob",
  "birth",
  "birthday",
  "birthdate",
  "name",
]);

const PII_COMPOUND_WORDS = new Set([
  "username",
  "firstname",
  "lastname",
  "fullname",
  "displayname",
  "apikey",
  "ipaddress",
  "phonenumber",
  "socialsecurity",
]);

function segments(identifier) {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function isPiiField(identifier) {
  if (PII_COMPOUND_WORDS.has(identifier.toLowerCase())) {
    return true;
  }
  return segments(identifier).some((segment) => PII_ROOTS.has(segment));
}

/** @type {import('eslint').Rule.RuleModule} */
const noAnalyticsPii = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban PII-shaped fields (emails, names, phone numbers, ...) in analytics track() payloads.",
    },
    messages: {
      pii: "'{{name}}' looks like a PII field. Analytics events must carry only IDs, enums, and counts — see apps/web/docs/analytics-event-schema.md.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "track") {
          return;
        }

        const propsArg = node.arguments[1];
        if (!propsArg || propsArg.type !== "ObjectExpression") {
          return;
        }

        for (const prop of propsArg.properties) {
          if (prop.type !== "Property") {
            continue; // a spread can't be checked statically — best-effort, not a payload scanner
          }

          const key =
            prop.key.type === "Identifier"
              ? prop.key.name
              : prop.key.type === "Literal" && typeof prop.key.value === "string"
                ? prop.key.value
                : null;
          if (key && isPiiField(key)) {
            context.report({ node: prop.key, messageId: "pii", data: { name: key } });
            continue;
          }

          const { value } = prop;
          const referencedName =
            value.type === "Identifier"
              ? value.name
              : value.type === "MemberExpression" &&
                  !value.computed &&
                  value.property.type === "Identifier"
                ? value.property.name
                : null;
          if (referencedName && isPiiField(referencedName)) {
            context.report({ node: prop.value, messageId: "pii", data: { name: referencedName } });
          }
        }
      },
    };
  },
};

export default noAnalyticsPii;
