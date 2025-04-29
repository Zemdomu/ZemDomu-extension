// src/extension.ts
import * as vscode from 'vscode';
import { lintHtml } from './linter';

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection('zemdomu');
  context.subscriptions.push(diagnostics);

  // Function to lint a single document
  async function lintDocument(uri: vscode.Uri, xmlMode: boolean) {
    const text = (await vscode.workspace.openTextDocument(uri)).getText();
    const results = lintHtml(text, xmlMode);
    const diags = results.map(res => {
      const range = new vscode.Range(
        new vscode.Position(res.line, res.column),
        new vscode.Position(res.line, res.column + 1)
      );
      return new vscode.Diagnostic(range, res.message, vscode.DiagnosticSeverity.Warning);
    });
    diagnostics.set(uri, diags);
  }

  // Function to lint the entire workspace
  async function lintWorkspace() {
    diagnostics.clear();
    // Find all .html, .jsx, .tsx files
    const files = await vscode.workspace.findFiles('**/*.{html,jsx,tsx}');
    await Promise.all(files.map(uri => {
      const lang = uri.fsPath.endsWith('.html') ? 'html'
        : uri.fsPath.endsWith('.jsx')  ? 'javascriptreact'
        : /*.tsx*/                    'typescriptreact';
      const xmlMode = (lang !== 'html');
      return lintDocument(uri, xmlMode);
    }));
  }

  // Trigger a workspace-wide lint on save of any relevant file
  vscode.workspace.onDidSaveTextDocument((document) => {
    const lang = document.languageId;
    if (['html','javascriptreact','typescriptreact'].includes(lang)) {
      lintWorkspace();
    }
  });

  // Optionally, also provide a manual “Run Semantic Linter” command
  context.subscriptions.push(
    vscode.commands.registerCommand('zemdomu.lintWorkspace', lintWorkspace)
  );

  // Initial run when the extension activates
  lintWorkspace().catch(console.error);

  console.log('ZemDomu extension is now active!');
}

export function deactivate() {}
