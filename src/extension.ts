import * as vscode from 'vscode';
import { lintHtml } from './linter';

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection('zemdomu');
  context.subscriptions.push(diagnostics);

  vscode.workspace.onDidSaveTextDocument((document) => {
    if (document.languageId !== 'html') return;

    console.log("ZemDomu Linter is running...");
    const results = lintHtml(document.getText());
    console.log("Lint results:", results);

    const diags: vscode.Diagnostic[] = results.map(res => {
      const range = new vscode.Range(
        new vscode.Position(res.line, res.column),
        new vscode.Position(res.line, res.column + 1)
      );
      return new vscode.Diagnostic(range, res.message, vscode.DiagnosticSeverity.Warning);
    });

    diagnostics.set(document.uri, diags);
  });

  console.log('ZemDomu extension is now active!');
}

export function deactivate() {}
