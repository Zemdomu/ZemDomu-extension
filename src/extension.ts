// src/extension.ts
import * as vscode from 'vscode';
import { lintHtml, LinterOptions, LintResult } from './linter';
import { ComponentAnalyzer } from './component-analyzer';

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
      }
    }

    return actions;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection('zemdomu');
  let saveDisp: vscode.Disposable | undefined;
  let typeDisp: vscode.Disposable | undefined;
  let componentAnalyzer: ComponentAnalyzer | undefined;
  let workspaceLinted = false;

  // Get linter options from configuration
  function getLinterOptions(): LinterOptions {
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
        requireImageInputAlt: config.get('rules.requireImageInputAlt', true)
      },
      crossComponentAnalysis: config.get('crossComponentAnalysis', true)
    };
  }

  function getRuleSeverity(rule: string): vscode.DiagnosticSeverity {
    const config = vscode.workspace.getConfiguration('zemdomu');
    const setting = config.get(`severity.${rule}`, 'warning') as string;
    return setting === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
  }

  async function lintDocument(uri: vscode.Uri, xmlMode: boolean) {
    try {
      const text = (await vscode.workspace.openTextDocument(uri)).getText();
      const results = lintHtml(text, xmlMode, getLinterOptions());
      
      // Also analyze component structure if this is a JSX/TSX file
      if (xmlMode && /\.(jsx|tsx)$/.test(uri.fsPath)) {
        if (!componentAnalyzer) {
          componentAnalyzer = new ComponentAnalyzer(getLinterOptions());
        }
        
        const component = await componentAnalyzer.analyzeFile(uri);
        if (component) {
          componentAnalyzer.registerComponent(component, results);
        }
      }
      
      const diags = results.map(r => {
        const start = new vscode.Position(r.line, r.column);
        const end = new vscode.Position(r.line, r.column + 1);
        return new vscode.Diagnostic(
          new vscode.Range(start, end),
          r.message,
          getRuleSeverity(r.rule)
        );
      });
      diagnostics.set(uri, diags);
    } catch (e) {
      console.debug('[ZemDomu] lintDocument parse error:', e instanceof Error ? e.message : String(e));
    }
  }
    async function lintSingleFile(doc: vscode.TextDocument) {
    const xmlMode = ['javascriptreact','typescriptreact'].includes(doc.languageId);
    await lintDocument(doc.uri, xmlMode);
  }


  async function lintWorkspace() {
    console.debug('[ZemDomu] Starting workspace lint');
    diagnostics.clear();
    
    // Create a new component analyzer with current config
    const options = getLinterOptions();
    componentAnalyzer = new ComponentAnalyzer(options);
    
    // Find and analyze all JSX/TSX files first
    const jsxFiles = await vscode.workspace.findFiles('**/*.{jsx,tsx}');
    console.debug(`[ZemDomu] Found ${jsxFiles.length} JSX/TSX files to analyze`);
    
    // First pass: analyze all components
    await Promise.all(jsxFiles.map(async uri => {
      console.debug(`[ZemDomu] Analyzing component: ${uri.fsPath}`);
      const text = (await vscode.workspace.openTextDocument(uri)).getText();
      const results = lintHtml(text, true, options);
      
      const component = await componentAnalyzer!.analyzeFile(uri);
      if (component) {
        componentAnalyzer!.registerComponent(component, results);
      }
      
      const diags = results.map(r => {
        const start = new vscode.Position(r.line, r.column);
        const end = new vscode.Position(r.line, r.column + 1);
        return new vscode.Diagnostic(new vscode.Range(start, end), r.message, getRuleSeverity(r.rule));
      });
      diagnostics.set(uri, diags);
    }));
    
    // Second pass: run cross-component analysis
    if (componentAnalyzer && options.crossComponentAnalysis) {
      console.debug('[ZemDomu] Running cross-component analysis');
      const crossComponentResults = componentAnalyzer.analyzeComponentTree();
      console.debug(`[ZemDomu] Found ${crossComponentResults.length} cross-component issues`);
      
      // Group results by file
      const resultsByFile = new Map<string, LintResult[]>();
      for (const result of crossComponentResults) {
        if (!result.filePath) {
          console.warn('[ZemDomu] Cross-component result missing filePath:', result);
          continue;
        }
        const fp = result.filePath;
        if (!resultsByFile.has(fp)) {
          resultsByFile.set(fp, []);
        }
        resultsByFile.get(fp)!.push(result);
      }
      
      // Add diagnostics for each file
      for (const [filePath, fileResults] of resultsByFile.entries()) {
        console.debug(`[ZemDomu] Adding ${fileResults.length} cross-component issues to ${filePath}`);
        const uri = vscode.Uri.file(filePath);
        const existingDiags = diagnostics.get(uri) || [];
        
        const newDiags = fileResults.map(r => {
          const start = new vscode.Position(r.line, r.column);
          const end = new vscode.Position(r.line, r.column + 1);
          return new vscode.Diagnostic(
            new vscode.Range(start, end),
            r.message,
            getRuleSeverity(r.rule)
          );
        });
        
        diagnostics.set(uri, [...existingDiags, ...newDiags]);
      }
    } else {
      console.debug('[ZemDomu] Skipping cross-component analysis (disabled in settings)');
    }
    
    // Also analyze HTML files
    const htmlFiles = await vscode.workspace.findFiles('**/*.html');
    console.debug(`[ZemDomu] Found ${htmlFiles.length} HTML files to analyze`);
    await Promise.all(htmlFiles.map(uri => lintDocument(uri, false)));
    
    console.debug('[ZemDomu] Workspace lint complete');
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