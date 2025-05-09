// src/extension.ts
import * as vscode from 'vscode';
import { lintHtml, LinterOptions, LintResult } from './linter';
import { ComponentAnalyzer } from './component-analyzer';

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection('zemdomu');
  let saveDisp: vscode.Disposable | undefined;
  let typeDisp: vscode.Disposable | undefined;
  let componentAnalyzer: ComponentAnalyzer | undefined;

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
      },
      crossComponentAnalysis: config.get<boolean>('enableCrossComponentAnalysis', true)
    };
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
        return new vscode.Diagnostic(new vscode.Range(start, end), r.message, vscode.DiagnosticSeverity.Warning);
      });
      diagnostics.set(uri, diags);
    } catch (e) {
      console.debug('[ZemDomu] lintDocument parse error:', e instanceof Error ? e.message : String(e));
    }
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
        return new vscode.Diagnostic(new vscode.Range(start, end), r.message, vscode.DiagnosticSeverity.Warning);
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
            vscode.DiagnosticSeverity.Warning
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
      if (e.affectsConfiguration('zemdomu.rules') || e.affectsConfiguration('zemdomu.enableCrossComponentAnalysis')) {
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