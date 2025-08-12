import * as vscode from "vscode";

import { PerformanceDiagnostics } from "./performance-diagnostics";
import { LintManager } from "./linting-manager";
import { ZemCodeActionProvider } from "./code-action-provider";

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection("zemdomu");
  const log = vscode.window.createOutputChannel("ZemDomu");
  const cfg = () => vscode.workspace.getConfiguration("zemdomu");

  const devMode = cfg().get("devMode", false) as boolean;
  const perfDiagnostics = new PerformanceDiagnostics(devMode);
  perfDiagnostics.reportBundleSize(context.extensionPath);

  const manager = new LintManager(diagnostics, log, perfDiagnostics);

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
          await manager.lintWorkspace();
          clearTimeout(slow);
          progress.report({ increment: 100 });
          return "Scan complete";
        }
      );
    }
  );

  const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration("zemdomu")) return;

    if (e.affectsConfiguration("zemdomu.devMode")) {
      const now = cfg().get("devMode", false) as boolean;
      perfDiagnostics.updateDevMode(now);
    }

    manager.rebuildCore();
    manager.updateListeners();
    await manager.lintWorkspace();
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
    manager,
    log
  );

  manager.updateListeners();

  setTimeout(() => {
    manager
      .lintWorkspace()
      .catch((err) => console.error("[ZemDomu] Initial lint error:", err));
  }, 750);

  log.appendLine("ZemDomu extension activated");
  console.log("ZemDomu extension is now active");
}

export function deactivate() {
  console.log("ZemDomu extension is deactivated");
}
