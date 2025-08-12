import * as vscode from "vscode";

export class ZemCodeActionProvider implements vscode.CodeActionProvider {
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
