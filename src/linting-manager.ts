import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ProjectLinter } from "zemdomu";
import type { ProjectLinterOptions, LintResult } from "zemdomu";
import { PerformanceDiagnostics } from "./performance-diagnostics";
import { Occurrence, remapCrossComponent } from "./cross-remap";

export class LintManager implements vscode.Disposable {
  private core: ProjectLinter | null = null;
  private workspaceLinted = false;
  private saveDisp?: vscode.Disposable;
  private typeDisp?: vscode.Disposable;

  constructor(
    private diagnostics: vscode.DiagnosticCollection,
    private log: vscode.OutputChannel,
    private perfDiagnostics: PerformanceDiagnostics
  ) {
    this.rebuildCore();
  }

  private cfg() {
    return vscode.workspace.getConfiguration("zemdomu");
  }

  private buildOptions(): ProjectLinterOptions {
    const c = this.cfg();

    const ruleNames = [
      "requireSectionHeading",
      "enforceHeadingOrder",
      "singleH1",
      "requireAltText",
      "requireLabelForFormControls",
      "enforceListNesting",
      "requireLinkText",
      "requireTableCaption",
      "preventEmptyInlineTags",
      "requireHrefOnAnchors",
      "requireButtonText",
      "requireIframeTitle",
      "requireHtmlLang",
      "requireImageInputAlt",
      "requireNavLinks",
      "uniqueIds",
    ] as const;

    const rules: Record<string, "off" | "warning" | "error"> = {};
    for (const name of ruleNames) {
      const enabled = c.get(`rules.${name}`, true) as boolean;
      rules[name] = enabled
        ? (c.get(`severity.${name}`, "warning") as "warning" | "error")
        : "off";
    }

    const crossComponentAnalysis = c.get(
      "crossComponentAnalysis",
      true
    ) as boolean;
    const crossComponentDepth = c.get("crossComponentDepth", 50) as number;
    const rootOverride = (c.get("rootDir", "") as string) || "";
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const rootDir = rootOverride || workspaceRoot || process.cwd();

    const opts: ProjectLinterOptions = {
      rules,
      crossComponentAnalysis,
      crossComponentDepth,
      rootDir,
      perf: this.perfDiagnostics,
    };

    this.log.appendLine(
      `Options: cross=${crossComponentAnalysis} depth=${crossComponentDepth} rootDir=${rootDir}`
    );
    return opts;
  }

  private ruleSeverity(rule: string): vscode.DiagnosticSeverity {
    const sev = this.cfg().get(`severity.${rule}`, "warning") as
      | "warning"
      | "error";
    return sev === "error"
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning;
  }

  rebuildCore() {
    this.core = new ProjectLinter(this.buildOptions());
    try {
      // helpful when debugging packaging issues
      // @ts-ignore
      this.log.appendLine(`zemdomu resolved at: ${require.resolve("zemdomu")}`);
    } catch {}
  }

  private resultsToDiagnostics(results: LintResult[]): vscode.Diagnostic[] {
    return results.map((r) => {
      const line = Number.isFinite(r.line) ? r.line : 0;
      const col = Number.isFinite(r.column) ? r.column : 0;
      const start = new vscode.Position(line, col);
      const end = new vscode.Position(line, Math.max(col + 1, col));
      const d = new vscode.Diagnostic(
        new vscode.Range(start, end),
        r.message,
        this.ruleSeverity(r.rule)
      );
      d.source = "ZemDomu";
      d.code = r.rule;
      return d;
    });
  }

  async lintEntries(entryUris: vscode.Uri[]) {
    if (!this.core) this.rebuildCore();

    // Entry files we will actively lint this pass
    const entries = entryUris
      .map((u) => u.fsPath)
      .filter(
        (p) =>
          !/[/\\]node_modules[/\\]/.test(p) && !/[/\\](dist|out)[/\\]/.test(p)
      );

    if (entries.length === 0 || !this.core) return;

    const t0 = Date.now();

    // Lint only entries via core
    const raw = await this.core.lintFiles(entries);

    // Build a comprehensive list of project files for name indexing and clearing diagnostics
    const include = "**/*.{html,jsx,tsx}";
    const exclude = "{**/node_modules/**,**/dist/**,**/out/**,**/.git/**}";
    const allFiles = await vscode.workspace.findFiles(include, exclude);
    const allPaths = allFiles.map((u) => u.fsPath);

    // Use the pure remapper to produce per-file diagnostics and entry summaries
    const { perFile, summaries } = remapCrossComponent(raw, (p) =>
      fs.readFileSync(p, "utf8")
    );

    // Clear diagnostics on all known files (prevents stale entries)
    for (const fp of allPaths) {
      this.diagnostics.set(vscode.Uri.file(fp), []);
    }

    // Apply diagnostics per file
    for (const [fp, results] of perFile.entries()) {
      // De-dup
      const seen = new Set<string>();
      const unique: LintResult[] = [];
      for (const r of results) {
        const key = `${r.rule}|${r.message}|${r.line}|${r.column}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(r);
        }
      }

      const uri = vscode.Uri.file(fp);
      const diags = this.resultsToDiagnostics(unique);

      // Attach one summary on entry files when multiple cross occurrences exist
      const occsRaw = summaries.get(fp) ?? [];

      const seenOcc = new Set<string>();
      const occs: Occurrence[] = [];
      for (const o of occsRaw) {
        const key = `${o.componentPath}:${o.line}:${o.column}`;
        if (!seenOcc.has(key)) {
          seenOcc.add(key);
          occs.push(o);
        }
      }

      if (occs.length > 1) {
        const summary = new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 0),
          "Multiple <h1> tags on this route.",
          vscode.DiagnosticSeverity.Warning
        );
        summary.source = "ZemDomu";
        summary.code = "singleH1";
        summary.relatedInformation = occs.map(
          (o) =>
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(
                vscode.Uri.file(o.componentPath),
                new vscode.Range(o.line, o.column, o.line, o.column + 1)
              ),
              `<h1> in ${o.componentName}`
            )
        );
        diags.push(summary);
      }

      this.perfDiagnostics.applyDiagnostics(uri, diags);
      this.diagnostics.set(uri, diags);
    }

    this.log.appendLine(
      `Linted ${Array.from(raw.keys()).length} files (entries=${
        entries.length
      }) in ${Date.now() - t0}ms`
    );
  }

  async lintWorkspace() {
    this.diagnostics.clear();

    const include = "**/*.{html,jsx,tsx}";
    const exclude = "{**/node_modules/**,**/dist/**,**/out/**,**/.git/**}";
    const files = await vscode.workspace.findFiles(include, exclude);

    await this.lintEntries(files);
    this.workspaceLinted = true;

    if (this.cfg().get("devMode", false) as boolean) {
      const metrics = PerformanceDiagnostics.getLatestMetrics();
      let slowFile = "";
      let slowTime = 0;
      let slowPhase = "";
      let slowPhaseTime = 0;
      for (const [file, times] of metrics.entries()) {
        if ((times.total ?? 0) > slowTime) {
          slowTime = times.total ?? 0;
          slowFile = file;
        }
        for (const [ph, t] of Object.entries(times)) {
          if (ph !== "total" && t > slowPhaseTime) {
            slowPhaseTime = t;
            slowPhase = ph;
          }
        }
      }
      this.perfDiagnostics.log(
        `Slowest file: ${path.basename(slowFile)} ${slowTime.toFixed(2)}ms`
      );
      this.perfDiagnostics.log(
        `Slowest phase: ${slowPhase} ${slowPhaseTime.toFixed(2)}ms`
      );
    }
  }

  async lintSingle(doc: vscode.TextDocument) {
    const isSupported = ["html", "javascriptreact", "typescriptreact"].includes(
      doc.languageId
    );
    if (!isSupported) return;
    await this.lintEntries([doc.uri]);
  }

  updateListeners() {
    this.saveDisp?.dispose();
    this.typeDisp?.dispose();

    const mode = this.cfg().get("run", "onSave") as
      | "onSave"
      | "onType"
      | "manual"
      | "disabled";

    if (mode === "onSave") {
      this.saveDisp = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (this.workspaceLinted) await this.lintSingle(doc);
        else await this.lintWorkspace();
      });
    } else if (mode === "onType") {
      this.typeDisp = vscode.workspace.onDidChangeTextDocument(async (evt) => {
        if (this.workspaceLinted) await this.lintSingle(evt.document);
        else await this.lintWorkspace();
      });
    } else {
      this.log.appendLine("Auto-lint disabled (manual mode).");
    }
  }

  dispose() {
    this.saveDisp?.dispose();
    this.typeDisp?.dispose();
  }
}
