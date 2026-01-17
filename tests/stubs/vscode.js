const fs = require('fs');
const path = require('path');

class Disposable {
  constructor(onDispose) {
    this._onDispose = onDispose;
    this._disposed = false;
  }

  dispose() {
    if (!this._disposed) {
      this._disposed = true;
      if (typeof this._onDispose === 'function') {
        try {
          this._onDispose();
        } catch {
          // ignore
        }
      }
    }
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

const DiagnosticSeverity = Object.freeze({
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
});

class Diagnostic {
  constructor(range, message, severity = DiagnosticSeverity.Warning) {
    this.range = range;
    this.message = message;
    this.severity = severity;
    this.code = undefined;
    this.source = undefined;
  }
}

class Location {
  constructor(uri, range) {
    this.uri = uri;
    this.range = range;
  }
}

class DiagnosticRelatedInformation {
  constructor(location, message) {
    this.location = location;
    this.message = message;
  }
}

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
    this.diagnostics = undefined;
    this.edit = undefined;
  }
}

const CodeActionKind = Object.freeze({
  QuickFix: 'quickfix',
});

class WorkspaceEdit {
  constructor() {
    this.operations = [];
  }

  insert(uri, position, value) {
    this.operations.push({
      type: 'insert',
      uri,
      position,
      value,
    });
  }
}

class Uri {
  constructor(value, scheme = 'file') {
    this.scheme = scheme;
    if (scheme === 'file') {
      this.fsPath = path.resolve(value);
      this.path = this.fsPath.split(path.sep).join(path.posix.sep);
    } else {
      this.fsPath = value;
      this.path = value;
    }
  }

  static file(fsPath) {
    return new Uri(fsPath, 'file');
  }

  static parse(value) {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
    const scheme = match ? match[1] : 'file';
    return new Uri(value, scheme);
  }

  toString() {
    return this.path;
  }
}

class StatusBarItem {
  constructor() {
    this.text = '';
    this.tooltip = '';
    this.command = undefined;
    this.name = 'ZemDomu';
    this.alignment = StatusBarAlignment.Left;
    this._visible = false;
  }

  show() {
    this._visible = true;
  }

  hide() {
    this._visible = false;
  }

  dispose() {
    this.hide();
  }
}

class OutputChannel {
  constructor(name) {
    this.name = name;
    this.lines = [];
  }

  appendLine(line) {
    this.lines.push(String(line));
  }

  clear() {
    this.lines = [];
  }

  dispose() {
    this.clear();
  }
}

class DiagnosticCollection {
  constructor(name) {
    this.name = name;
    this._map = new Map();
  }

  set(uri, diagnostics) {
    const key = uri instanceof Uri ? uri.fsPath : String(uri);
    this._map.set(key, diagnostics.slice());
  }

  get(uri) {
    const key = uri instanceof Uri ? uri.fsPath : String(uri);
    return this._map.get(key);
  }

  delete(uri) {
    const key = uri instanceof Uri ? uri.fsPath : String(uri);
    this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  dispose() {
    this.clear();
  }

  __entries() {
    return new Map(this._map);
  }
}

const registeredCommands = new Map();
const diagnosticCollections = new Map();
const codeActionProviders = [];
const configurationListeners = new Set();
const findFileRegistry = new Map();

const StatusBarAlignment = Object.freeze({
  Left: 1,
  Right: 2,
});

const ProgressLocation = Object.freeze({
  Notification: 15,
});

const configValues = new Map();
function primeConfigDefaults() {
  configValues.set('run', 'onSave');
  configValues.set('devMode', false);
  configValues.set('crossComponentAnalysis', true);
  const rules = [
    'requireSectionHeading',
    'enforceHeadingOrder',
    'singleH1',
    'requireAltText',
    'requireLabelForFormControls',
    'enforceListNesting',
    'requireLinkText',
    'requireTableCaption',
    'preventEmptyInlineTags',
    'requireHrefOnAnchors',
    'requireButtonText',
    'requireIframeTitle',
    'requireHtmlLang',
    'requireImageInputAlt',
    'requireNavLinks',
    'uniqueIds',
  ];
  for (const rule of rules) {
    configValues.set(`rules.${rule}`, true);
    configValues.set(`severity.${rule}`, 'warning');
  }
}

primeConfigDefaults();

function ensureUri(value) {
  return value instanceof Uri ? value : Uri.file(value);
}

function parseFindFileExts(pattern) {
  if (typeof pattern !== 'string') return new Set();
  const braceMatch = pattern.match(/\{([^}]+)\}/);
  if (braceMatch) {
    return new Set(
      braceMatch[1]
        .split(',')
        .map(ext => ext.trim().replace(/^\./, ''))
        .filter(Boolean)
    );
  }
  const extMatch = pattern.match(/\.([a-z0-9]+)$/i);
  return extMatch ? new Set([extMatch[1]]) : new Set();
}

function guessLanguageId(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jsx') return 'javascriptreact';
  if (ext === '.tsx') return 'typescriptreact';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.vue') return 'vue';
  return 'plaintext';
}

const workspace = {
  workspaceFolders: [],
  textDocuments: [],

  getConfiguration(section) {
    if (section !== 'zemdomu') {
      return {
        get: (_key, defaultValue) => defaultValue,
      };
    }
    return {
      get(key, defaultValue) {
        if (!key) return defaultValue;
        if (configValues.has(key)) {
          return configValues.get(key);
        }
        if (key.startsWith('rules.')) return configValues.get(key) ?? true;
        if (key.startsWith('severity.')) return configValues.get(key) ?? 'warning';
        return defaultValue;
      },
    };
  },

  __setConfiguration(key, value) {
    configValues.set(key, value);
  },

  __resetConfiguration() {
    configValues.clear();
    primeConfigDefaults();
  },

  __setWorkspaceFolders(folders) {
    this.workspaceFolders = folders.map(folder => ({
      uri: ensureUri(folder.uri ?? folder),
      name: folder.name ?? path.basename(ensureUri(folder.uri ?? folder).fsPath),
    }));
  },

  findFiles(pattern) {
    const entries = findFileRegistry.get(pattern);
    if (entries) return Promise.resolve(entries.map(ensureUri));

    const requestedExts = parseFindFileExts(pattern);
    if (requestedExts.size === 0) return Promise.resolve([]);

    const merged = new Map();
    for (const [key, values] of findFileRegistry.entries()) {
      const keyExts = parseFindFileExts(key);
      if (keyExts.size === 0) continue;
      let isSubset = true;
      for (const ext of keyExts) {
        if (!requestedExts.has(ext)) {
          isSubset = false;
          break;
        }
      }
      if (!isSubset) continue;
      for (const value of values) {
        const uri = ensureUri(value);
        merged.set(uri.fsPath, uri);
      }
    }

    return Promise.resolve(Array.from(merged.values()));
  },

  __setFindFiles(pattern, filePaths) {
    findFileRegistry.set(pattern, filePaths.map(p => ensureUri(p)));
  },

  openTextDocument(uri) {
    const actualUri = ensureUri(uri);
    const text = fs.readFileSync(actualUri.fsPath, 'utf8');
    const lines = text.split(/\r?\n/);
    const doc = {
      uri: actualUri,
      languageId: guessLanguageId(actualUri.fsPath),
      getText: () => text,
      lineAt: index => ({ text: lines[index] ?? '' }),
    };
    this.textDocuments.push(doc);
    return Promise.resolve(doc);
  },

  onDidSaveTextDocument() {
    return new Disposable();
  },

  onDidChangeTextDocument() {
    return new Disposable();
  },

  onDidChangeConfiguration(listener) {
    configurationListeners.add(listener);
    return new Disposable(() => configurationListeners.delete(listener));
  },
};

const window = {
  createStatusBarItem() {
    const item = new StatusBarItem();
    return item;
  },

  withProgress(_options, task) {
    const progress = {
      report: () => {},
    };
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => new Disposable(),
    };
    try {
      return Promise.resolve(task(progress, token));
    } catch (error) {
      return Promise.reject(error);
    }
  },

  showInformationMessage() {
    return Promise.resolve(undefined);
  },

  showErrorMessage() {
    return Promise.resolve(undefined);
  },

  createOutputChannel(name) {
    return new OutputChannel(name);
  },
};

const languages = {
  createDiagnosticCollection(name) {
    const collection = new DiagnosticCollection(name);
    diagnosticCollections.set(name, collection);
    return collection;
  },

  registerCodeActionsProvider() {
    const disposable = new Disposable(() => {
      const index = codeActionProviders.indexOf(disposable);
      if (index >= 0) codeActionProviders.splice(index, 1);
    });
    codeActionProviders.push(disposable);
    return disposable;
  },

  __getCollection(name) {
    return diagnosticCollections.get(name);
  },

  __reset() {
    diagnosticCollections.clear();
    codeActionProviders.splice(0, codeActionProviders.length);
  },
};

const commands = {
  registerCommand(name, handler) {
    registeredCommands.set(name, handler);
    return new Disposable(() => registeredCommands.delete(name));
  },

  __get(name) {
    return registeredCommands.get(name);
  },

  __execute(name, ...args) {
    const handler = registeredCommands.get(name);
    if (!handler) throw new Error(`Command not registered: ${name}`);
    return handler(...args);
  },

  __reset() {
    registeredCommands.clear();
  },
};

module.exports = {
  CodeAction,
  CodeActionKind,
  commands,
  Diagnostic,
  DiagnosticRelatedInformation,
  DiagnosticSeverity,
  Disposable,
  languages,
  Location,
  Position,
  ProgressLocation,
  Range,
  StatusBarAlignment,
  Uri,
  window,
  workspace,
  WorkspaceEdit,

  __resetAll() {
    commands.__reset();
    languages.__reset();
    workspace.__resetConfiguration();
    workspace.__setWorkspaceFolders([]);
    workspace.textDocuments = [];
    findFileRegistry.clear();
    configurationListeners.clear();
  },
};
