import * as vscode from "vscode";
import type { LintResult } from "zemdomu";

export type CanonicalDiagnosticSeverity = "error" | "warning" | "info";

export interface CanonicalSourceLocation {
  file: string;
  line: number;
  column: number;
  offset?: number;
}

export interface CanonicalZemDomuDiagnostic {
  schemaVersion: "1.0";
  rule: string;
  code: string;
  severity: CanonicalDiagnosticSeverity;
  message: string;
  source: CanonicalSourceLocation;
  page?: string;
  componentPath?: string[];
  relatedLocations?: Array<{
    source: CanonicalSourceLocation;
    message?: string;
  }>;
  preferredEditLocation?: CanonicalSourceLocation;
  suggestion?: {
    message: string;
    replacement?: string;
  };
  provenance?: {
    kind: "source" | "cross-component" | "inference";
    analyzer?: string;
    description?: string;
  };
  confidence?: "certain" | "inferred" | "unknown";
}

export type CanonicalLintResult = LintResult & {
  canonicalDiagnostic: CanonicalZemDomuDiagnostic;
};

export interface PageAwareProjectLinter {
  lintFiles(filePaths: string[]): Promise<Map<string, LintResult[]>>;
  lintPageDiagnostics?: (
    filePaths: string[]
  ) => Promise<CanonicalZemDomuDiagnostic[]>;
}

function safePosition(location: CanonicalSourceLocation): vscode.Position {
  return new vscode.Position(
    Number.isFinite(location.line) ? Math.max(0, location.line) : 0,
    Number.isFinite(location.column) ? Math.max(0, location.column) : 0
  );
}

function locationRange(location: CanonicalSourceLocation): vscode.Range {
  const start = safePosition(location);
  return new vscode.Range(
    start,
    new vscode.Position(start.line, start.character + 1)
  );
}

function diagnosticSeverity(
  severity: CanonicalDiagnosticSeverity
): vscode.DiagnosticSeverity {
  if (severity === "error") return vscode.DiagnosticSeverity.Error;
  if (severity === "info") return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Warning;
}

function diagnosticMessage(diagnostic: CanonicalZemDomuDiagnostic): string {
  const lines = [diagnostic.message];
  if (diagnostic.page) lines.push(`Page: ${diagnostic.page}`);
  if (diagnostic.componentPath?.length) {
    lines.push(`Component path: ${diagnostic.componentPath.join(" → ")}`);
  }
  if (diagnostic.suggestion?.message) {
    lines.push(`Suggestion: ${diagnostic.suggestion.message}`);
  }
  return lines.join("\n");
}

export function canonicalDiagnosticToLintResult(
  diagnostic: CanonicalZemDomuDiagnostic
): CanonicalLintResult {
  return {
    line: diagnostic.source.line,
    column: diagnostic.source.column,
    ...(diagnostic.source.offset === undefined
      ? {}
      : { offset: diagnostic.source.offset }),
    message: diagnostic.message,
    rule: diagnostic.rule,
    code: diagnostic.code,
    severity: diagnostic.severity === "info" ? "warning" : diagnostic.severity,
    filePath: diagnostic.source.file,
    related: diagnostic.relatedLocations?.map((related) => ({
      filePath: related.source.file,
      line: related.source.line,
      column: related.source.column,
      ...(related.message === undefined ? {} : { message: related.message }),
    })),
    canonicalDiagnostic: diagnostic,
  };
}

export function isCanonicalLintResult(
  result: LintResult
): result is CanonicalLintResult {
  return "canonicalDiagnostic" in result;
}

export async function lintProjectForPresentation(
  linter: PageAwareProjectLinter,
  filePaths: string[]
): Promise<Map<string, LintResult[]>> {
  if (typeof linter.lintPageDiagnostics !== "function") {
    return linter.lintFiles(filePaths);
  }

  const diagnostics = await linter.lintPageDiagnostics(filePaths);
  const grouped = new Map<string, LintResult[]>(
    filePaths.map((filePath) => [filePath, []])
  );
  for (const diagnostic of diagnostics) {
    const filePath = diagnostic.source.file;
    if (!grouped.has(filePath)) grouped.set(filePath, []);
    grouped.get(filePath)!.push(canonicalDiagnosticToLintResult(diagnostic));
  }
  return grouped;
}

export function canonicalDiagnosticToVscode(
  diagnostic: CanonicalZemDomuDiagnostic,
  docsUri?: vscode.Uri | null
): vscode.Diagnostic {
  const mapped = new vscode.Diagnostic(
    locationRange(diagnostic.source),
    diagnosticMessage(diagnostic),
    diagnosticSeverity(diagnostic.severity)
  );
  mapped.source = "ZemDomu";
  mapped.code = docsUri
    ? { value: diagnostic.code, target: docsUri }
    : diagnostic.code;

  const related = (diagnostic.relatedLocations ?? []).map((location) =>
    new vscode.DiagnosticRelatedInformation(
      new vscode.Location(
        vscode.Uri.file(location.source.file),
        locationRange(location.source)
      ),
      location.message ?? "Related location"
    )
  );
  if (diagnostic.preferredEditLocation) {
    related.push(
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(
          vscode.Uri.file(diagnostic.preferredEditLocation.file),
          locationRange(diagnostic.preferredEditLocation)
        ),
        "Preferred edit location"
      )
    );
  }
  if (related.length > 0) mapped.relatedInformation = related;
  return mapped;
}
