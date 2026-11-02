const SESSION_SET_RE = /^SET\s(?!LOCAL\s)/i;
const RESET_RE = /^RESET\s/i;

/** @type {import('eslint').Rule.RuleModule} */
const noSessionSet = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban session-level SET and RESET in .unsafe() calls — they leak across pooled connections.",
    },
    messages: {
      sessionSet:
        "Session-level SET leaks GUC state across pooled connections. Use SET LOCAL or the withTenantTx helper.",
      reset:
        "RESET is session-scoped and leaks across pooled connections. Avoid RESET in application code.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "unsafe"
        ) {
          return;
        }

        const [firstArg] = node.arguments;
        if (!firstArg || firstArg.type !== "Literal" || typeof firstArg.value !== "string") {
          return;
        }

        const sql = firstArg.value.trim().replace(/\s+/g, " ");

        if (SESSION_SET_RE.test(sql)) {
          context.report({ node: firstArg, messageId: "sessionSet" });
          return;
        }

        if (RESET_RE.test(sql)) {
          context.report({ node: firstArg, messageId: "reset" });
        }
      },
    };
  },
};

export default noSessionSet;
