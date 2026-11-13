// The names apps/api gives the raw postgres.js pool (`Database`): the API's own convention, not a type
// check. A query on the pool itself runs as the PgBouncer login with no `SET LOCAL ROLE` and no
// `app.school_id`, so Row-Level Security is either bypassed (if that login can bypass it) or matches
// nothing (S-01, docs/security/findings-register.md).
const POOL_NAMES = new Set(["database", "db", "primary", "readReplica"]);

function isPool(node) {
  if (node.type === "Identifier") return POOL_NAMES.has(node.name);
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    POOL_NAMES.has(node.property.name)
  );
}

/** @type {import('eslint').Rule.RuleModule} */
const noRawPoolQuery = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban queries on the raw database pool; they run with no role and no tenant scope (S-01).",
    },
    messages: {
      rawPoolQuery:
        "This queries the raw pool as the database login, with no role and no tenant scope (S-01). " +
        "Use withTenantTx/withSystemTx, or allowlist the file in eslint.config.js with a reason.",
    },
    schema: [],
  },
  create(context) {
    return {
      // database`...` and database<Row[]>`...`
      TaggedTemplateExpression(node) {
        if (isPool(node.tag)) context.report({ node, messageId: "rawPoolQuery" });
      },
      // database.unsafe("...")
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          callee.property.name === "unsafe" &&
          isPool(callee.object)
        ) {
          context.report({ node, messageId: "rawPoolQuery" });
        }
      },
    };
  },
};

export default noRawPoolQuery;
