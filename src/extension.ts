// src/extension.ts
import * as vscode from 'vscode';
import { ProjectLinter } from '../../ZemDomu-Core/out/project-linter';
import type { ProjectLinterOptions } from '../../ZemDomu-Core/out/project-linter';
import type { LintResult } from '../../ZemDomu-Core/out/linter';
import { PerformanceDiagnostics } from './performance-diagnostics';
import { ComponentPathResolver } from '../../ZemDomu-Core/out/component-path-resolver';
import * as path from 'path';

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
      const gt = lineText.indexOf('>', diag.range.start.character);
      if (gt === -1) {
        continue;
      }
      const insertPos = new vscode.Position(
        diag.range.start.line,
        lineText[gt - 1] === '/' ? gt - 1 : gt
      );

      if (diag.message.includes('img') && diag.message.includes('alt')) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, insertPos, ' alt=""');
        const action = new vscode.CodeAction(
          'Add empty alt attribute',
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      } else if (diag.message.includes('href attribute')) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, insertPos, ' href=""');
        const action = new vscode.CodeAction(
          'Add empty href attribute',
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      } else if (diag.message.includes('missing <caption>')) {
        const capPos = new vscode.Position(diag.range.start.line, gt + 1);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, capPos, '\n  <caption></caption>');
        const action = new vscode.CodeAction(
          'Add empty <caption>',
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      } else if (diag.message.includes('missing title attribute') || diag.message.includes('title attribute is empty')) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, insertPos, ' title=""');
        const action = new vscode.CodeAction(
          'Add empty title attribute',
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      } else if (diag.message.includes('missing lang attribute') || diag.message.includes('lang attribute is empty')) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, insertPos, ' lang=""');
        const action = new vscode.CodeAction(
          'Add empty lang attribute',
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      } else if (diag.message.includes('accessible text') || diag.message.includes('aria-label attribute is empty')) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, insertPos, ' aria-label=""');
        const action = new vscode.CodeAction(
          'Add empty aria-label attribute',
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      } else if (diag.message.includes('input type="image"') && diag.message.includes('alt attribute')) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, insertPos, ' alt=""');
        const action = new vscode.CodeAction(
          'Add empty alt attribute',
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      }
    }

    return actions;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection('zemdomu');
  const devMode = vscode.workspace.getConfiguration('zemdomu').get('devMode', false);
  const perfDiagnostics = new PerformanceDiagnostics(devMode);
  ComponentPathResolver.updateDevMode(devMode);
  const rootDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  ComponentPathResolver.setRootDir(rootDir);
  perfDiagnostics.reportBundleSize(context.extensionPath);
  let saveDisp: vscode.Disposable | undefined;
  let typeDisp: vscode.Disposable | undefined;
  let projectLinter: ProjectLinter | undefined;
  let workspaceLinted = false;

  // Get linter options from configuration
  function getLinterOptions(): ProjectLinterOptions {
    const config = vscode.workspace.getConfiguration('zemdomu');
    return {
      rules: {
requireSectionHeading: config.get('rules.requireSectionHeading', true),
        enforceHeadingOrder: config.get('rules.enforceHeadingOrder', true),
        singleH1: config.get('rules.singleH1', true),
        requireAltText: config.get('rules.requireAltText', true),
        requireLabelForFormControls: config.get('rules.requireLabelForFormControls', true),
        enforceListNesting: config.get('rules.enforceListNesting', true),
        requireLinkText: config.get('rules.requireLinkText', true),
        requireTableCaption: config.get('rules.requireTableCaption', true),
        preventEmptyInlineTags: config.get('rules.preventEmptyInlineTags', true),
        requireHrefOnAnchors: config.get('rules.requireHrefOnAnchors', true),
        requireButtonText: config.get('rules.requireButtonText', true),
        requireIframeTitle: config.get('rules.requireIframeTitle', true),
        requireHtmlLang: config.get('rules.requireHtmlLang', true),
        requireImageInputAlt: config.get('rules.requireImageInputAlt', true),
        requireNavLinks: config.get('rules.requireNavLinks', true),
        uniqueIds: config.get('rules.uniqueIds', true)
      },
      crossComponentAnalysis: config.get('crossComponentAnalysis', true)
    };
  }

  function getRuleSeverity(rule: string): vscode.DiagnosticSeverity {
    const config = vscode.workspace.getConfiguration('zemdomu');
    const setting = config.get(`severity.${rule}`, 'warning') as string;
    return setting === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
  }

  async function lintDocument(uri: vscode.Uri) {
    try {
      if (uri.fsPath.includes('node_modules')) {
        return;
      }
      const text = (await vscode.workspace.openTextDocument(uri)).getText();
      const options = getLinterOptions();
      if (!projectLinter) {
        projectLinter = new ProjectLinter(options);
      }

      const resultMap = await projectLinter.lintFile(uri.fsPath, text);
      for (const [filePath, fileResults] of resultMap.entries()) {
        const fileUri = vscode.Uri.file(filePath);
        const newDiags = fileResults.map(r => {
          const start = new vscode.Position(r.line, r.column);
          const end = new vscode.Position(r.line, r.column + 1);
          return new vscode.Diagnostic(new vscode.Range(start, end), r.message, getRuleSeverity(r.rule));
        });
        perfDiagnostics.applyDiagnostics(fileUri, newDiags);
        diagnostics.set(fileUri, newDiags);
      }
    } catch (e) {
      if (vscode.workspace.getConfiguration('zemdomu').get('devMode', false)) {
        console.debug('[ZemDomu] lintDocument parse error:', e instanceof Error ? e.message : String(e));
      }
    }
  }
  async function lintSingleFile(doc: vscode.TextDocument) {
    await lintDocument(doc.uri);
  }


  async function lintWorkspace() {
    const dev = vscode.workspace.getConfiguration('zemdomu').get('devMode', false);
    if (dev) console.debug('[ZemDomu] Starting workspace lint');
    diagnostics.clear();
    
    const options = getLinterOptions();
    projectLinter = new ProjectLinter(options);
    
    // Find and analyze all JSX/TSX files first
    const jsxFiles = await vscode.workspace.findFiles('**/*.{jsx,tsx}', '**/node_modules/**');
    if (dev) console.debug(`[ZemDomu] Found ${jsxFiles.length} JSX/TSX files to analyze`);
    
    for (const uri of jsxFiles) {
      if (dev) console.debug(`[ZemDomu] Analyzing component: ${uri.fsPath}`);
      const text = (await vscode.workspace.openTextDocument(uri)).getText();
      const resultMap = await projectLinter!.lintFile(uri.fsPath, text);
      for (const [filePath, fileResults] of resultMap.entries()) {
        const fileUri = vscode.Uri.file(filePath);
        const newDiags = fileResults.map(r => {
          const start = new vscode.Position(r.line, r.column);
          const end = new vscode.Position(r.line, r.column + 1);
          return new vscode.Diagnostic(new vscode.Range(start, end), r.message, getRuleSeverity(r.rule));
        });
        perfDiagnostics.applyDiagnostics(fileUri, newDiags);
        diagnostics.set(fileUri, newDiags);
      }
    }
    
    // Also analyze HTML files
    const htmlFiles = await vscode.workspace.findFiles('**/*.html', '**/node_modules/**');
    if (dev) console.debug(`[ZemDomu] Found ${htmlFiles.length} HTML files to analyze`);
    await Promise.all(htmlFiles.map(uri => lintDocument(uri)));
    
    if (dev) {
      const metrics = PerformanceDiagnostics.getLatestMetrics();
      let slowFile = '';
      let slowTime = 0;
      let slowPhase = '';
      let slowPhaseTime = 0;
      for (const [file, times] of metrics.entries()) {
        if ((times.total ?? 0) > slowTime) {
          slowTime = times.total ?? 0;
          slowFile = file;
        }
        for (const [ph, t] of Object.entries(times)) {
          if (ph !== 'total' && t > slowPhaseTime) {
            slowPhaseTime = t;
            slowPhase = ph;
          }
        }
      }
      perfDiagnostics.log(`Slowest file: ${path.basename(slowFile)} ${slowTime.toFixed(2)}ms`);
      perfDiagnostics.log(`Slowest phase: ${slowPhase} ${slowPhaseTime.toFixed(2)}ms`);
    }
    if (dev) console.debug('[ZemDomu] Workspace lint complete');
    workspaceLinted = true;
  }

  function updateListeners() {
    // tear down old
    saveDisp?.dispose();
    typeDisp?.dispose();
    const runMode = vscode.workspace.getConfiguration('zemdomu').get('run', 'onSave');
    if (runMode === 'onSave') {
      console.log('[ZemDomu] onSave enabled');
      saveDisp = vscode.workspace.onDidSaveTextDocument(doc => {
        if (['html','javascriptreact','typescriptreact'].includes(doc.languageId)) {
          if (workspaceLinted) {
            lintSingleFile(doc);
          } else {
            lintWorkspace();
          }
        }
      });
    } else if (runMode === 'onType') {
      console.log('[ZemDomu] onType enabled');
      typeDisp = vscode.workspace.onDidChangeTextDocument(evt => {
        if (['html','javascriptreact','typescriptreact'].includes(evt.document.languageId)) {
          if (workspaceLinted) {
            lintSingleFile(evt.document);
          } else {
            lintWorkspace();
          }
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
      const slowMsg = setTimeout(() => {
        vscode.window.showInformationMessage('ZemDomu: Scanning entire workspace, this may take some time...');
      }, 5000);
      await lintWorkspace();
      clearTimeout(slowMsg);
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

      if (e.affectsConfiguration('zemdomu.devMode')) {
        const dev = vscode.workspace.getConfiguration('zemdomu').get('devMode', false);
        perfDiagnostics.updateDevMode(dev);
        ComponentPathResolver.updateDevMode(dev);
        const rootDir2 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        ComponentPathResolver.setRootDir(rootDir2);
      }
      
      // If any rules changed, re-run linting
      if (e.affectsConfiguration('zemdomu.rules') || e.affectsConfiguration('zemdomu.crossComponentAnalysis')) {
        lintWorkspace();
      }
    }
  });

    const actionProvider = vscode.languages.registerCodeActionsProvider(
    ['html', 'javascriptreact', 'typescriptreact'],
    new ZemCodeActionProvider(),
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  );

  // Add all subscriptions
  context.subscriptions.push(
    lintCommand,
    configWatcher,
    diagnostics,
    actionProvider
  );

  // Initial setup
  updateListeners();
  
  // Initial lint with a slight delay to let things settle
  setTimeout(() => {
    lintWorkspace().catch(error => {
      console.error('[ZemDomu] Initial lint error:', error);
    });
  }, 1000);

  console.log('ZemDomu extension is now active');
}

export function deactivate() {
  console.log('ZemDomu extension is deactivated');
}