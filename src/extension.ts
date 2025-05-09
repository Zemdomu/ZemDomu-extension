// src/extension.ts
import * as vscode from 'vscode';
import { lintHtml, LinterOptions } from './linter';

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection('zemdomu');
  let saveDisp: vscode.Disposable | undefined;
  let typeDisp: vscode.Disposable | undefined;

  // Get linter options from configuration
  function getLinterOptions(): LinterOptions {
    const config = vscode.workspace.getConfiguration('zemdomu');
    return {
      rules: {
        requireSectionHeading: config.get<boolean>('rules.requireSectionHeading', true),
        enforceHeadingOrder: config.get<boolean>('rules.enforceHeadingOrder', true),
        singleH1: config.get<boolean>('rules.singleH1', true),
        requireAltText: config.get<boolean>('rules.requireAltText', true),
        requireLabelForFormControls: config.get<boolean>('rules.requireLabelForFormControls', true),
        enforceListNesting: config.get<boolean>('rules.enforceListNesting', true),
        requireLinkText: config.get<boolean>('rules.requireLinkText', true),
        requireTableCaption: config.get<boolean>('rules.requireTableCaption', true),
        preventEmptyInlineTags: config.get<boolean>('rules.preventEmptyInlineTags', true),
        requireHrefOnAnchors: config.get<boolean>('rules.requireHrefOnAnchors', true)
      }
    };
  }

  async function lintDocument(uri: vscode.Uri, xmlMode: boolean) {
    try {
      const text = (await vscode.workspace.openTextDocument(uri)).getText();
      const results = lintHtml(text, xmlMode, getLinterOptions());
      const diags = results.map(r => {
        const start = new vscode.Position(r.line, r.column);
        const end = new vscode.Position(r.line, r.column + 1);
        return new vscode.Diagnostic(new vscode.Range(start, end), r.message, vscode.DiagnosticSeverity.Warning);
      });
      diagnostics.set(uri, diags);
    } catch (e) {
      console.debug('[ZemDomu] lintDocument parse error:', e instanceof Error ? e.message : String(e));
    }
  }

  async function lintWorkspace() {
    diagnostics.clear();
    const files = await vscode.workspace.findFiles('**/*.{html,jsx,tsx}');
    await Promise.all(files.map(uri => {
      const xmlMode = /\.(jsx|tsx)$/.test(uri.fsPath);
      return lintDocument(uri, xmlMode);
    }));
  }

  function updateListeners() {
    // tear down old
    saveDisp?.dispose();
    typeDisp?.dispose();
    const runMode = vscode.workspace.getConfiguration('zemdomu').get<'onSave'|'onType'|'manual'|'disabled'>('run', 'onSave');
    if (runMode === 'onSave') {
      console.log('[ZemDomu] onSave enabled');
      saveDisp = vscode.workspace.onDidSaveTextDocument(doc => {
        if (['html','javascriptreact','typescriptreact'].includes(doc.languageId)) {
          lintWorkspace();
        }
      });
    } else if (runMode === 'onType') {
      console.log('[ZemDomu] onType enabled');
      typeDisp = vscode.workspace.onDidChangeTextDocument(evt => {
        if (['html','javascriptreact','typescriptreact'].includes(evt.document.languageId)) {
          lintWorkspace();
        }
      });
    } else {
      console.log('[ZemDomu] manual or disabled (no auto-lint)');
    }
  }

  // Register command for manual linting
  const lintCommand = vscode.commands.registerCommand('zemdomu.lintWorkspace', () => {
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "ZemDomu: Scanning for semantic issues...",
      cancellable: false
    }, async (progress) => {
      progress.report({ increment: 0 });
      await lintWorkspace();
      progress.report({ increment: 100 });
      return "Scan complete";
    });
  });

  // Watch for configuration changes
  const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('zemdomu')) {
      // If run mode changed, update listeners
      if (e.affectsConfiguration('zemdomu.run')) {
        updateListeners();
      }
      
      // If any rules changed, re-run linting
      if (e.affectsConfiguration('zemdomu.rules')) {
        lintWorkspace();
      }
    }
  });

  // Add all subscriptions
  context.subscriptions.push(
    lintCommand,
    configWatcher,
    diagnostics
  );

  // Initial setup
  updateListeners();
  lintWorkspace().catch(error => {
    console.error('[ZemDomu] Initial lint error:', error);
  });

  console.log('ZemDomu extension is now active');
}

export function deactivate() {
  console.log('ZemDomu extension is deactivated');
}