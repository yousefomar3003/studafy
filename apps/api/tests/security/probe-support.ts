export interface ExplainNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: ExplainNode[];
}

export interface PlanInspection {
  nodeTypes: string[];
  indexNames: string[];
  sequentialRelations: string[];
}

export interface ProbeDiagnostic {
  operation: string;
  relation: string;
  primaryKey: string;
  expectedTenant: string;
  observedTenant?: string;
  backendPid?: number;
  rowCount?: number;
  sqlState?: string;
  plan?: unknown;
}

export function inspectPlan(root: ExplainNode): PlanInspection {
  const inspection: PlanInspection = { nodeTypes: [], indexNames: [], sequentialRelations: [] };
  const visit = (node: ExplainNode): void => {
    inspection.nodeTypes.push(node["Node Type"]);
    if (node["Index Name"]) inspection.indexNames.push(node["Index Name"]);
    if (node["Node Type"] === "Seq Scan") {
      inspection.sequentialRelations.push(node["Relation Name"] ?? "<unknown>");
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  return inspection;
}

export function formatProbeDiagnostic(diagnostic: ProbeDiagnostic): string {
  return JSON.stringify(diagnostic, null, 2);
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
