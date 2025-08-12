import * as vscode from "vscode";
import * as path from "path";

import { ProjectLinter } from "zemdomu";
import type { ProjectLinterOptions, LintResult } from "zemdomu";

import { PerformanceDiagnostics } from "./performance-diagnostics";

/** Quick fixes (unchanged) */
class ZemCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
    const actions: vscode.CodeAction[] = [];

    for (const diag of context.diagnostics) {
      const line = document.lineAt(diag.range.start.line);
      const lineText = line.text;
      const gt = lineText.indexOf(">", diag.range.start.character);
      if (gt === -1) continue;

      const insertPos = new vscode.Position(
        diag.range.start.line,
        lineText[gt - 1] === "/" ? gt - 1 : gt
      );

      const addAttr = (
        title: string,
        snippet: string,
        match: (m: string) => boolean
      ) => {
        if (!match(diag.message)) return;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, insertPos, ` ${snippet}`);
        const action = new vscode.CodeAction(
          title,
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      };

      addAttr(
        "Add empty alt attribute",
        `alt=""`,
        (m) => m.includes("img") && m.includes("alt")
      );
      addAttr("Add empty href attribute", `href=""`, (m) =>
        m.includes("href attribute")
      );
      if (diag.message.includes("missing <caption>")) {
        const capPos = new vscode.Position(diag.range.start.line, gt + 1);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, capPos, "\n  <caption></caption>");
        const action = new vscode.CodeAction(
          "Add empty <caption>",
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      }
      addAttr(
        "Add empty title attribute",
        `title=""`,
        (m) =>
          m.includes("missing title attribute") ||
          m.includes("title attribute is empty")
      );
      addAttr(
        "Add empty lang attribute",
        `lang=""`,
        (m) =>
          m.includes("missing lang attribute") ||
          m.includes("lang attribute is empty")
      );
      addAttr(
        "Add empty aria-label attribute",
        `aria-label=""`,
        (m) =>
          m.includes("accessible text") ||
          m.includes("aria-label attribute is empty")
      );
      addAttr(
        "Add empty alt attribute",
        `alt=""`,
        (m) => m.includes('input type="image"') && m.includes("alt attribute")
      );
    }

    return actions;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection("zemdomu");
  const log = vscode.window.createOutputChannel("ZemDomu");
  const cfg = () => vscode.workspace.getConfiguration("zemdomu");

  const devMode = cfg().get("devMode", false) as boolean;
  const perfDiagnostics = new PerformanceDiagnostics(devMode);
  perfDiagnostics.reportBundleSize(context.extensionPath);

  // Single ProjectLinter instance, rebuilt when settings change
  let core: ProjectLinter | null = null;
  let workspaceLinted = false;

  function buildOptions(): ProjectLinterOptions {
    const c = cfg();

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
      if (!enabled) {
        rules[name] = "off";
      } else {
        const sev = c.get(`severity.${name}`, "warning") as "warning" | "error";
        rules[name] = sev;
      }
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
      perf: perfDiagnostics,
    };

    log.appendLine(
      `Options: cross=${crossComponentAnalysis} depth=${crossComponentDepth} rootDir=${rootDir}`
    );
    return opts;
  }

  function ruleSeverity(rule: string): vscode.DiagnosticSeverity {
    const sev = cfg().get(`severity.${rule}`, "warning") as "warning" | "error";
    return sev === "error"
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning;
  }

  function rebuildCore() {
    core = new ProjectLinter(buildOptions());
    try {
      // helpful when debugging packaging issues
      // @ts-ignore
      log.appendLine(`zemdomu resolved at: ${require.resolve("zemdomu")}`);
    } catch {}
  }
  rebuildCore();

  function resultsToDiagnostics(results: LintResult[]): vscode.Diagnostic[] {
    return results.map((r) => {
      const line = Number.isFinite(r.line) ? r.line : 0;
      const col = Number.isFinite(r.column) ? r.column : 0;
      const start = new vscode.Position(line, col);
      const end = new vscode.Position(line, Math.max(col + 1, col));
      const d = new vscode.Diagnostic(
        new vscode.Range(start, end),
        r.message,
        ruleSeverity(r.rule)
      );
      d.source = "ZemDomu";
      d.code = r.rule;
      return d;
    });
  }

  async function lintEntries(entryUris: vscode.Uri[]) {
    if (!core) rebuildCore();
    const entries = entryUris
      .map((u) => u.fsPath)
      .filter(
        (p) =>
          !/[/\\]node_modules[/\\]/.test(p) && !/[/\\](dist|out)[/\\]/.test(p)
      );

    if (entries.length === 0 || !core) return;

    const t0 = Date.now();
    const map = await core.lintFiles(entries);
    const files = Array.from(map.keys());

    const nameIndex = new Map<string, string[]>();
    for (const fp of files) {
      const base = path.basename(fp, path.extname(fp));
      if (!nameIndex.has(base)) nameIndex.set(base, []);
      nameIndex.get(base)!.push(fp);
    }

    const remapped = new Map<string, LintResult[]>();
    for (const [fp, results] of map.entries()) {
      for (const r of results) {
        let target = fp;
        let adjusted: LintResult = r;
        if (r.rule === "singleH1") {
          const m = r.message.match(/component '([^']+)'/);
          if (m) {
            const name = m[1];
            const candidates = nameIndex.get(name);
            if (candidates && candidates.length === 1) {
              target = candidates[0];
              adjusted = { ...r, line: 0, column: 0, filePath: target };
            }
          }
        }
        if (!remapped.has(target)) remapped.set(target, []);
        remapped.get(target)!.push(adjusted);
      }
    }

    const toClear = new Set<string>([...files, ...entries]);
    for (const fp of toClear) {
      diagnostics.set(vscode.Uri.file(fp), []);
    }

    for (const [fp, results] of remapped.entries()) {
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
      const diags = resultsToDiagnostics(unique);
      perfDiagnostics.applyDiagnostics(uri, diags);
      diagnostics.set(uri, diags);
    }

    log.appendLine(
      `Linted ${files.length} files (entries=${entries.length}) in ${
        Date.now() - t0
      }ms`
    );
  }

  async function lintWorkspace() {
    diagnostics.clear();
    const include = "**/*.{html,jsx,tsx}";
    const exclude = "{**/node_modules/**,**/dist/**,**/out/**,**/.git/**}";
    const files = await vscode.workspace.findFiles(include, exclude);
    await lintEntries(files);
    workspaceLinted = true;

    if (cfg().get("devMode", false) as boolean) {
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
      perfDiagnostics.log(
        `Slowest file: ${path.basename(slowFile)} ${slowTime.toFixed(2)}ms`
      );
      perfDiagnostics.log(
        `Slowest phase: ${slowPhase} ${slowPhaseTime.toFixed(2)}ms`
      );
    }
  }

  async function lintSingle(doc: vscode.TextDocument) {
    const isSupported = ["html", "javascriptreact", "typescriptreact"].includes(
      doc.languageId
    );
    if (!isSupported) return;
    await lintEntries([doc.uri]);
  }

  /** Auto-run wiring */
  let saveDisp: vscode.Disposable | undefined;
  let typeDisp: vscode.Disposable | undefined;

  function updateListeners() {
    saveDisp?.dispose();
    typeDisp?.dispose();

    const mode = cfg().get("run", "onSave") as
      | "onSave"
      | "onType"
      | "manual"
      | "disabled";

    if (mode === "onSave") {
      saveDisp = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (workspaceLinted) await lintSingle(doc);
        else await lintWorkspace();
      });
    } else if (mode === "onType") {
      typeDisp = vscode.workspace.onDidChangeTextDocument(async (evt) => {
        if (workspaceLinted) await lintSingle(evt.document);
        else await lintWorkspace();
      });
    } else {
      log.appendLine("Auto-lint disabled (manual mode).");
    }
  }

  /** Command: Scan Workspace */
  const lintCommand = vscode.commands.registerCommand(
    "zemdomu.lintWorkspace",
    () => {
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "ZemDomu: Scanning…",
          cancellable: false,
        },
        async (progress) => {
          const slow = setTimeout(
            () =>
              vscode.window.showInformationMessage(
                "ZemDomu is scanning the workspace…"
              ),
            5000
          );
          progress.report({ increment: 0 });
          await lintWorkspace();
          clearTimeout(slow);
          progress.report({ increment: 100 });
          return "Scan complete";
        }
      );
    }
  );

  /** React to settings changes */
  const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration("zemdomu")) return;

    if (e.affectsConfiguration("zemdomu.devMode")) {
      const now = cfg().get("devMode", false) as boolean;
      perfDiagnostics.updateDevMode(now);
    }

    // Rebuild linter with new options and relint
    rebuildCore();
    updateListeners();
    await lintWorkspace();
  });

  const actionProvider = vscode.languages.registerCodeActionsProvider(
    ["html", "javascriptreact", "typescriptreact"],
    new ZemCodeActionProvider(),
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  );

  context.subscriptions.push(
    diagnostics,
    lintCommand,
    configWatcher,
    actionProvider,
    { dispose: () => saveDisp?.dispose() },
    { dispose: () => typeDisp?.dispose() },
    log
  );

  updateListeners();

  // First pass after a short delay
  setTimeout(() => {
    lintWorkspace().catch((err) =>
      console.error("[ZemDomu] Initial lint error:", err)
    );
  }, 750);

  log.appendLine("ZemDomu extension activated");
  console.log("ZemDomu extension is now active");
}

export function deactivate() {
  console.log("ZemDomu extension is deactivated");
}
