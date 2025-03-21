"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// src/extension.ts
var vscode = require("vscode");
var linter_1 = require("./linter");
function activate(context) {
    var diagnostics = vscode.languages.createDiagnosticCollection('zemdomu');
    context.subscriptions.push(diagnostics);
    vscode.workspace.onDidSaveTextDocument(function (document) {
        if (document.languageId !== 'html')
            return;
        console.log("ZemDomu Linter is running..."); // Debugging log
        var results = (0, linter_1.lintHtml)(document.getText());
        console.log("Lint results:", results); // Debugging log
        var diags = results.map(function (res) {
            var range = new vscode.Range(new vscode.Position(res.line, res.column), new vscode.Position(res.line, res.column + 1));
            return new vscode.Diagnostic(range, res.message, vscode.DiagnosticSeverity.Warning);
        });
        diagnostics.set(document.uri, diags);
    });
    console.log('ZemDomu extension is now active!');
}
function deactivate() { }
