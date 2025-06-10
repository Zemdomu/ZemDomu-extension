// src/linter.ts
import { Parser } from 'htmlparser2';
import { parse } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

export interface LintResult {
  line: number;
  column: number;
  message: string;
  /** Identifier for the rule that produced this result */
  rule: string;
  filePath?: string;
}

export interface LinterOptions {
  crossComponentAnalysis: boolean;
  rules: {
    requireSectionHeading: boolean;
    enforceHeadingOrder: boolean;
    singleH1: boolean;
    requireAltText: boolean;
    requireLabelForFormControls: boolean;
    enforceListNesting: boolean;
    requireLinkText: boolean;
    requireTableCaption: boolean;
    preventEmptyInlineTags: boolean;
    requireHrefOnAnchors: boolean;
    requireButtonText: boolean;
    requireIframeTitle: boolean;
    requireHtmlLang: boolean;
    requireImageInputAlt: boolean;
  };
}

// Default options
const defaultOptions: LinterOptions = {
  crossComponentAnalysis: true,
  rules: {
    requireSectionHeading: true,
    enforceHeadingOrder: true,
    singleH1: true,
    requireAltText: true,
    requireLabelForFormControls: true,
    enforceListNesting: true,
    requireLinkText: true,
    requireTableCaption: true,
    preventEmptyInlineTags: true,
    requireHrefOnAnchors: true,
    requireButtonText: true,
    requireIframeTitle: true,
    requireHtmlLang: true,
    requireImageInputAlt: true
  }
};

/**
 * Lint HTML or JSX/TSX content for semantic issues.
 * @param content The file content
 * @param xmlMode true to parse as JSX/TSX, false for plain HTML
 * @param options Configuration options for the linter
 */
export function lintHtml(content: string, xmlMode = false, options: LinterOptions = defaultOptions): LintResult[] {
  return xmlMode ? lintJsx(content, options) : lintHtmlString(content, options);
}

// === Plain HTML branch using htmlparser2 ===
function lintHtmlString(html: string, options: LinterOptions): LintResult[] {
  const results: LintResult[] = [];
  const tagStack: Array<{ tag: string; line: number; column: number }> = [];
  let lastHeadingLevel = 0;
  let h1Count = 0;
  const sectionStack: Array<{ foundHeading: boolean; line: number; column: number }> = [];
  const anchorStack: Array<{ foundText: boolean; line: number; column: number }> = [];
  const buttonStack: Array<{ foundText: boolean; line: number; column: number }> = [];
  const tableStack: Array<{ foundCaption: boolean; line: number; column: number }> = [];
  const emptyStack: Array<{ tag: string; foundText: boolean; line: number; column: number }> = [];
  const labels = new Set<string>();
  let ignoreNext = false;
  let ignoreBlock = false;
  let curLine = 0;
  let curCol = 0;
  const inlineTags = new Set(['strong','em','b','i','u','small','mark','del','ins']);
  let htmlSeen = false;

  const parser = new Parser({
    oncomment(data) {
      const trimmed = data.trim();
      if (trimmed.startsWith('zemdomu-disable-next')) {
        ignoreNext = true;
      } else if (trimmed.startsWith('zemdomu-disable')) {
        ignoreBlock = true;
      } else if (trimmed.startsWith('zemdomu-enable')) {
        ignoreBlock = false;
      }
    },
    ontext(text) {
      const parts = text.split('\n');
      if (parts.length > 1) {
        curLine += parts.length - 1;
        curCol = parts[parts.length - 1].length;
      } else {
        curCol += text.length;
      }
      if (ignoreBlock) return;
      const trimmed = text.trim();
      if (anchorStack.length && trimmed) anchorStack[anchorStack.length - 1].foundText = true;
      if (emptyStack.length && trimmed) emptyStack[emptyStack.length - 1].foundText = true;
      if (buttonStack.length && trimmed) buttonStack[buttonStack.length - 1].foundText = true;
    },
    onopentag(name, attrs) {
      const tag = name.toLowerCase();
      const pos = { tag, line: curLine, column: curCol };
      tagStack.push(pos);
      if (ignoreNext) { ignoreNext = false; return; }
      if (ignoreBlock) return;

      // labels
      if (tag === 'label' && attrs.for) labels.add(attrs.for);

      // html lang
      if (options.rules.requireHtmlLang && tag === 'html' && !htmlSeen) {
        htmlSeen = true;
        const lang = attrs.lang;
        if (!lang || !lang.trim()) {
          results.push({ ...pos, message: '<html> element missing lang attribute', rule: 'requireHtmlLang' });
        }
      }

      // iframe title
      if (options.rules.requireIframeTitle && tag === 'iframe') {
        const title = attrs.title;
        if (!title || !title.trim()) {
          results.push({ ...pos, message: '<iframe> missing title attribute', rule: 'requireIframeTitle' });
        }
      }

      // input type=image alt
      if (options.rules.requireImageInputAlt && tag === 'input' && attrs.type && attrs.type.toLowerCase() === 'image') {
        const alt = attrs.alt;
        if (!alt || !alt.trim()) {
          results.push({ ...pos, message: '<input type="image"> missing alt attribute', rule: 'requireImageInputAlt' });
        }
      }

      // form controls
      if (options.rules.requireLabelForFormControls && ['input','select','textarea'].includes(tag)) {
        const id = attrs.id;
        const aria = attrs['aria-label'];
        if (!aria || !aria.trim()) {
          if (!id) results.push({ ...pos, message: 'Form control missing id or aria-label', rule: 'requireLabelForFormControls' });
          else if (!labels.has(id)) results.push({ ...pos, message: `Form control with id="${id}" missing <label for=\"${id}\">`, rule: 'requireLabelForFormControls' });
        }
      }
      
      // only one h1
      if (options.rules.singleH1 && tag === 'h1') {
        h1Count++;
        if (h1Count > 1) results.push({ ...pos, message: 'Only one <h1> allowed per document', rule: 'singleH1' });
      }
      
      // heading order
      if (options.rules.enforceHeadingOrder && /^h[1-6]$/.test(tag)) {
        const lvl = parseInt(tag.charAt(1), 10);
        if (lastHeadingLevel && lvl > lastHeadingLevel + 1) {
          results.push({ ...pos, message: `Heading level skipped: <${tag}> after <h${lastHeadingLevel}>`, rule: 'enforceHeadingOrder' });
        }
        lastHeadingLevel = lvl;
        if (sectionStack.length) sectionStack[sectionStack.length - 1].foundHeading = true;
      }
      
      // img alt
      if (options.rules.requireAltText && tag === 'img') {
        const alt = attrs.alt;
        if (!alt || !alt.trim()) results.push({ ...pos, message: '<img> tag missing non-empty alt attribute', rule: 'requireAltText' });
      }
      
      // li nesting
      if (options.rules.enforceListNesting && tag === 'li') {
        const parent = tagStack[tagStack.length - 2];
        if (!parent || !['ul','ol'].includes(parent.tag)) {
          results.push({ ...pos, message: '<li> must be inside a <ul> or <ol>', rule: 'enforceListNesting' });
        }
      }
      
      // anchor
      if (tag === 'a') {
        anchorStack.push({ ...pos, foundText: false });
        
        if (options.rules.requireHrefOnAnchors) {
          const href = attrs.href;
          if (!href || !href.trim()) results.push({ ...pos, message: '<a> tag missing non-empty href attribute', rule: 'requireHrefOnAnchors' });
        }
      }

      // button text
      if (options.rules.requireButtonText && tag === 'button') {
        const aria = attrs['aria-label'];
        buttonStack.push({ ...pos, foundText: !!(aria && aria.trim()) });
      }
      
      // table caption
      if (tag === 'table') tableStack.push({ ...pos, foundCaption: false });
      if (tag === 'caption' && tableStack.length) tableStack[tableStack.length - 1].foundCaption = true;
      
      // empty inline
      if (options.rules.preventEmptyInlineTags && inlineTags.has(tag)) emptyStack.push({ ...pos, foundText: false });
      
      // section heading
      if (options.rules.requireSectionHeading && tag === 'section') sectionStack.push({ ...pos, foundHeading: false });
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      tagStack.pop();

      if (ignoreBlock) return;
      
      if (options.rules.preventEmptyInlineTags && inlineTags.has(tag)) {
        const e = emptyStack.pop();
        if (e && !e.foundText) results.push({ line: e.line, column: e.column, message: `<${tag}> tag should not be empty`, rule: 'preventEmptyInlineTags' });
      }
      
      if (options.rules.requireLinkText && tag === 'a') {
        const a = anchorStack.pop();
        if (a && !a.foundText) results.push({ line: a.line, column: a.column, message: '<a> tag missing link text', rule: 'requireLinkText' });
      }

      if (options.rules.requireButtonText && tag === 'button') {
        const b = buttonStack.pop();
        if (b && !b.foundText) results.push({ line: b.line, column: b.column, message: '<button> missing accessible text', rule: 'requireButtonText' });
      }
      
      if (options.rules.requireSectionHeading && tag === 'section') {
        const s = sectionStack.pop();
        if (s && !s.foundHeading) results.push({ line: s.line, column: s.column, message: '<section> missing heading (<h1>-<h6>)', rule: 'requireSectionHeading' });
      }
      
      if (options.rules.requireTableCaption && tag === 'table') {
        const t = tableStack.pop();
        if (t && !t.foundCaption) results.push({ line: t.line, column: t.column, message: '<table> missing <caption>', rule: 'requireTableCaption' });
      }
    }
  }, { decodeEntities: true, xmlMode: false, recognizeSelfClosing: true });

  parser.write(html);
  parser.end();
  return results;
}

// === JSX/TSX branch using Babel ===
function lintJsx(code: string, options: LinterOptions): LintResult[] {
  const results: LintResult[] = [];
  
  try {
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], tokens: true, sourceFilename: '' });

    const disableNextLines = new Set<number>();
    const disableBlocks: Array<{ start: number; end: number }> = [];
    let blockStart: number | null = null;
    if (Array.isArray(ast.comments)) {
      for (const c of ast.comments) {
        const val = c.value.trim();
        const startLine = c.loc?.start.line ?? 0;
        const endLine = c.loc?.end.line ?? startLine;
        if (val.startsWith('zemdomu-disable-next')) {
          disableNextLines.add(endLine + 1);
        } else if (val.startsWith('zemdomu-disable')) {
          blockStart = endLine;
        } else if (val.startsWith('zemdomu-enable')) {
          if (blockStart !== null) {
            disableBlocks.push({ start: blockStart, end: startLine });
            blockStart = null;
          }
        }
      }
      if (blockStart !== null) {
        disableBlocks.push({ start: blockStart, end: Number.MAX_SAFE_INTEGER });
      }
    }

    function isIgnored(line: number): boolean {
      if (disableNextLines.has(line)) return true;
      return disableBlocks.some(b => line >= b.start && line <= b.end);
    }

    let lastHeadingLevel = 0;
    let h1Count = 0;
    const sectionStack: Array<{ foundHeading: boolean; line: number; column: number }> = [];
    const anchorStack: Array<{ foundText: boolean; line: number; column: number }> = [];
    const buttonStack: Array<{ foundText: boolean; line: number; column: number }> = [];
    const tableStack: Array<{ foundCaption: boolean; line: number; column: number }> = [];
    const emptyStack: Array<{ tag: string; foundText: boolean; line: number; column: number }> = [];
    const labels = new Set<string>();
    let htmlSeen = false;

    traverse(ast, {
      JSXElement: {
        enter(path: NodePath<t.JSXElement>) {
          const opening = path.node.openingElement;
          if (!t.isJSXIdentifier(opening.name)) return;
          const tag = opening.name.name.toLowerCase();
          const loc = opening.loc?.start;
          if (!loc) return;
          const pos = { line: loc.line - 1, column: loc.column };
          if (isIgnored(loc.line)) return;

          // labels
          opening.attributes.forEach(attr => {
            if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === 'for') {
              if (t.isStringLiteral(attr.value)) labels.add(attr.value.value);
            }
          });

          if (options.rules.requireHtmlLang && tag === 'html' && !htmlSeen) {
            htmlSeen = true;
            const hasLang = opening.attributes.some(attr =>
              t.isJSXAttribute(attr) &&
              t.isJSXIdentifier(attr.name) &&
              attr.name.name === 'lang' &&
              t.isStringLiteral(attr.value) && attr.value.value.trim() !== ''
            );
            if (!hasLang) {
              results.push({ ...pos, message: '<html> element missing lang attribute', rule: 'requireHtmlLang' });
            }
          }

          if (options.rules.requireIframeTitle && tag === 'iframe') {
            const hasTitle = opening.attributes.some(attr =>
              t.isJSXAttribute(attr) &&
              t.isJSXIdentifier(attr.name) &&
              attr.name.name === 'title' &&
              t.isStringLiteral(attr.value) && attr.value.value.trim() !== ''
            );
            if (!hasTitle) {
              results.push({ ...pos, message: '<iframe> missing title attribute', rule: 'requireIframeTitle' });
            }
          }

          if (options.rules.requireImageInputAlt && tag === 'input') {
            let isImage = false;
            let altVal: string | undefined;
            opening.attributes.forEach(attr => {
              if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name)) {
                if (attr.name.name === 'type' && t.isStringLiteral(attr.value)) {
                  isImage = attr.value.value.toLowerCase() === 'image';
                }
                if (attr.name.name === 'alt' && t.isStringLiteral(attr.value)) {
                  altVal = attr.value.value;
                }
              }
            });
            if (isImage && (!altVal || !altVal.trim())) {
              results.push({ ...pos, message: '<input type="image"> missing alt attribute', rule: 'requireImageInputAlt' });
            }
          }
          
          // form controls
          if (options.rules.requireLabelForFormControls && ['input', 'select', 'textarea'].includes(tag)) {
            let idVal: string | undefined;
            let ariaVal: string | undefined;
            opening.attributes.forEach(attr => {
              if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name)) {
                if (attr.name.name === 'id' && t.isStringLiteral(attr.value)) idVal = attr.value.value;
                if (attr.name.name === 'aria-label' && t.isStringLiteral(attr.value)) ariaVal = attr.value.value;
              }
            });
            if (!ariaVal || !ariaVal.trim()) {
              if (!idVal) results.push({ ...pos, message: 'Form control missing id or aria-label', rule: 'requireLabelForFormControls' });
              else if (!labels.has(idVal)) results.push({ ...pos, message: `Form control with id="${idVal}" missing <label for=\"${idVal}\">`, rule: 'requireLabelForFormControls' });
            }
          }
          
          // only one h1
          if (options.rules.singleH1 && tag === 'h1') { 
            h1Count++; 
            if (h1Count > 1) results.push({ ...pos, message: 'Only one <h1> allowed per document', rule: 'singleH1' });
          }
          
          // heading order
          if (options.rules.enforceHeadingOrder && /^h[1-6]$/.test(tag)) {
            const lvl = parseInt(tag.charAt(1), 10);
            if (lastHeadingLevel && lvl > lastHeadingLevel + 1) results.push({ ...pos, message: `Heading level skipped: <${tag}> after <h${lastHeadingLevel}>`, rule: 'enforceHeadingOrder' });
            lastHeadingLevel = lvl;
            if (sectionStack.length) sectionStack[sectionStack.length - 1].foundHeading = true;
          }
          
          // img alt
          if (options.rules.requireAltText && tag === 'img') {
            const hasAlt = opening.attributes.some(attr =>
              t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === 'alt' &&
              t.isStringLiteral(attr.value) && attr.value.value.trim() !== ''
            );
            if (!hasAlt) results.push({ ...pos, message: '<img> missing non-empty alt attribute', rule: 'requireAltText' });
          }
          
          // li nesting
          if (options.rules.enforceListNesting && tag === 'li') {
            const parent = path.parentPath?.node as t.JSXElement;
            if (t.isJSXElement(parent)) {
              const p = parent.openingElement.name;
              if (t.isJSXIdentifier(p)) {
                const pTag = p.name.toLowerCase();
                if (!['ul', 'ol'].includes(pTag)) results.push({ ...pos, message: '<li> must be inside a <ul> or <ol>', rule: 'enforceListNesting' });
              }
            }
          }
          
          // anchors
          if (tag === 'a') {
            anchorStack.push({ ...pos, foundText: false });
            
            if (options.rules.requireHrefOnAnchors) {
              const hrefVal = opening.attributes.find(a => 
                t.isJSXAttribute(a) && 
                t.isJSXIdentifier((a as t.JSXAttribute).name) && 
                (a as t.JSXAttribute).name.name === 'href'
              ) as t.JSXAttribute | undefined;
              
              if (!hrefVal || !t.isStringLiteral(hrefVal.value) || !hrefVal.value.value.trim()) {
                results.push({ ...pos, message: '<a> tag missing non-empty href attribute', rule: 'requireHrefOnAnchors' });
              }
            }
          }

          if (options.rules.requireButtonText && tag === 'button') {
            let hasAria = false;
            opening.attributes.forEach(attr => {
              if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === 'aria-label' && t.isStringLiteral(attr.value)) {
                if (attr.value.value.trim()) hasAria = true;
              }
            });
            buttonStack.push({ ...pos, foundText: hasAria });
          }
          
          // table caption
          if (tag === 'table') tableStack.push({ ...pos, foundCaption: false });
          if (tag === 'caption' && tableStack.length) tableStack[tableStack.length - 1].foundCaption = true;
          
          // empty inline
          if (options.rules.preventEmptyInlineTags && ['strong','em','b','i','u','small','mark','del','ins'].includes(tag)) {
            emptyStack.push({ ...pos, tag, foundText: false });
          }
          
          // section
          if (options.rules.requireSectionHeading && tag === 'section') {
            sectionStack.push({ ...pos, foundHeading: false });
          }
        },
        exit(path: NodePath<t.JSXElement>) {
          const opening = path.node.openingElement;
          if (!t.isJSXIdentifier(opening.name) || !opening.loc) return;
          if (isIgnored(opening.loc.start.line)) return;
          const tag = opening.name.name.toLowerCase();
          const pos = { line: opening.loc.start.line - 1, column: opening.loc.start.column };
          
          if (options.rules.preventEmptyInlineTags && ['strong','em','b','i','u','small','mark','del','ins'].includes(tag)) {
            const e = emptyStack.pop();
            if (e && !e.foundText) results.push({ ...e, message: `<${tag}> tag should not be empty`, rule: 'preventEmptyInlineTags' });
          }
          
          if (options.rules.requireLinkText && tag === 'a') {
            const a = anchorStack.pop();
            if (a && !a.foundText) results.push({ ...a, message: '<a> tag missing link text', rule: 'requireLinkText' });
          }

          if (options.rules.requireButtonText && tag === 'button') {
            const b = buttonStack.pop();
            if (b && !b.foundText) results.push({ ...b, message: '<button> missing accessible text', rule: 'requireButtonText' });
          }
          
          if (options.rules.requireSectionHeading && tag === 'section') {
            const s = sectionStack.pop();
            if (s && !s.foundHeading) results.push({ ...s, message: '<section> missing heading (<h1>-<h6>)', rule: 'requireSectionHeading' });
          }
          
          if (options.rules.requireTableCaption && tag === 'table') {
            const tableEntry = tableStack.pop();
            if (tableEntry && !tableEntry.foundCaption) {
              results.push({ ...tableEntry, message: '<table> missing <caption>', rule: 'requireTableCaption' });
            }
          }
        }
      },
      JSXText(path) {
        if (isIgnored(path.node.loc?.start.line ?? 0)) return;
        const text = path.node.value.trim();
        if (text && anchorStack.length) {
          anchorStack[anchorStack.length - 1].foundText = true;
        }
        if (text && emptyStack.length) {
          emptyStack[emptyStack.length - 1].foundText = true;
        }
        if (text && buttonStack.length) {
          buttonStack[buttonStack.length - 1].foundText = true;
        }
      },
      JSXExpressionContainer(path) {
        // Consider JSX expressions as potential text content
        if (isIgnored(path.node.loc?.start.line ?? 0)) return;
        if (anchorStack.length) {
          anchorStack[anchorStack.length - 1].foundText = true;
        }
        if (emptyStack.length) {
          emptyStack[emptyStack.length - 1].foundText = true;
        }
        if (buttonStack.length) {
          buttonStack[buttonStack.length - 1].foundText = true;
        }
      }
    });

    return results;
  } catch (e) {
    // Handle parsing errors gracefully
    console.error('Error parsing JSX/TSX:', e);
    return [{
      line: 0,
      column: 0,
      message: `Error parsing JSX/TSX: ${e instanceof Error ? e.message : String(e)}`,
      rule: 'parseError'
    }];
  }
}