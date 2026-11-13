/**
 * ST-297 SQL injection guardrail. Every query in apps/api goes through postgres.js, whose tagged
 * template (`` tx`... ${value} ...` ``) sends each `${}` as a bound parameter — the value never
 * becomes SQL text, so it cannot change the statement. The library's one escape hatch is
 * `.unsafe(text, params?)`, which sends `text` to the server verbatim. That is the only place a
 * string can be spliced into SQL, so that is the only place this rule looks.
 *
 * The first argument to `.unsafe()` must be *static*: a string literal, a template literal whose
 * every `${}` is itself static, a `+` concatenation of static parts, or a `const` binding whose
 * initializer is static (`` SELECT ${tx.unsafe(INVOICE_COLUMNS)} `` stays legal). Anything whose
 * value is only known at runtime — a function parameter, a `let`, a call result, a property read —
 * is reported, because a syntax-level rule cannot prove where it came from. Values belong in the
 * `params` array (`tx.unsafe("... $1", [value])`) or, better, a tagged template.
 *
 * Deliberately a blunt syntactic check, like `no-unsafe-html-render`: it does not follow imports or
 * read TypeScript types. A genuinely safe dynamic call (e.g. a `"COMMIT" | "ROLLBACK"` union) is
 * disabled inline with a comment saying why, so every exception is visible in review.
 */

/** @param {import('estree').Node} node */
function isUnsafeCall(node) {
  const { callee } = node;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "unsafe"
  );
}

/**
 * @param {import('eslint').Scope.Scope} scope
 * @param {string} name
 */
function findVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) {
      return variable;
    }
  }
  return null;
}

/**
 * @param {import('estree').Node} node
 * @param {import('eslint').Scope.Scope} scope
 * @param {Set<string>} visiting names already on the resolution path, to stop `const a = b, b = a`
 */
function isStaticSql(node, scope, visiting = new Set()) {
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" || typeof node.value === "number";
    case "TemplateLiteral":
      return node.expressions.every((expression) => isStaticSql(expression, scope, visiting));
    case "BinaryExpression":
      return (
        node.operator === "+" &&
        isStaticSql(node.left, scope, visiting) &&
        isStaticSql(node.right, scope, visiting)
      );
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      return isStaticSql(node.expression, scope, visiting);
    case "Identifier": {
      if (visiting.has(node.name)) {
        return false;
      }
      const variable = findVariable(scope, node.name);
      const definition = variable?.defs.length === 1 ? variable.defs[0] : null;
      if (
        !definition ||
        definition.type !== "Variable" ||
        definition.parent.kind !== "const" ||
        definition.node.id.type !== "Identifier" ||
        !definition.node.init
      ) {
        return false;
      }
      visiting.add(node.name);
      return isStaticSql(definition.node.init, variable.scope, visiting);
    }
    default:
      return false;
  }
}

/** @type {import('eslint').Rule.RuleModule} */
const noInterpolatedSql = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require the SQL text passed to postgres.js `.unsafe()` to be static; runtime values must be bound parameters.",
    },
    messages: {
      dynamicUnsafeSql:
        '`.unsafe()` sends its first argument to Postgres as raw SQL, and this one is built from runtime values. Use a tagged template (tx`... ${value}`) or pass values as bound parameters (tx.unsafe("... $1", [value])). See CONTRIBUTING.md › SQL safety.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isUnsafeCall(node)) {
          return;
        }
        const [sqlText] = node.arguments;
        if (!sqlText) {
          return;
        }
        if (!isStaticSql(sqlText, context.sourceCode.getScope(node))) {
          context.report({ node: sqlText, messageId: "dynamicUnsafeSql" });
        }
      },
    };
  },
};

export default noInterpolatedSql;
