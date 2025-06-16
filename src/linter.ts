// src/linter.ts
import { parse as parseHtmlDom } from './simpleHtmlParser';
import { parse } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import {
  isJSXIdentifier,
  isJSXAttribute,
  isJSXElement,
  isStringLiteral
} from '@babel/types';
import type { JSXElement, JSXAttribute } from '@babel/types';

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
    requireNavLinks: boolean;
    uniqueIds: boolean;
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
    requireImageInputAlt: true,
    requireNavLinks: true,
    uniqueIds: true
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

// === Plain HTML branch using a lightweight parser ===
function lintHtmlString(html: string, options: LinterOptions): LintResult[] {
  const results: LintResult[] = [];
  const root = parseHtmlDom(html);
  const tagStack: Array<{ tag: string; line: number; column: number }> = [];
  let lastHeadingLevel = 0;
  let h1Count = 0;
  const sectionStack: Array<{ foundHeading: boolean; line: number; column: number }> = [];
  const anchorStack: Array<{ foundText: boolean; line: number; column: number }> = [];
  const buttonStack: Array<{ foundText: boolean; line: number; column: number; hadEmptyAria: boolean }> = [];
  const tableStack: Array<{ foundCaption: boolean; line: number; column: number }> = [];
  const emptyStack: Array<{ tag: string; foundText: boolean; line: number; column: number }> = [];
  const labels = new Set<string>();
  let ignoreNext = false;
  let ignoreBlock = false;
  const inlineTags = new Set(['strong','em','b','i','u','small','mark','del','ins']);
  let htmlSeen = false;
  const navStack: Array<{ line: number; column: number; hasLink: boolean }> = [];
  const ids = new Map<string, { line: number; column: number }>();

  function getPos(idx: number) {
    const lines = html.slice(0, idx).split('\n');
    return { line: lines.length - 1, column: lines[lines.length - 1].length };
  }

  function traverse(node: import('./simpleHtmlParser').Node): void {
    if (node.type === 'comment') {
      const trimmed = node.text.trim();
      if (trimmed.startsWith('zemdomu-disable-next')) {
        ignoreNext = true;
      } else if (trimmed.startsWith('zemdomu-disable')) {
        ignoreBlock = true;
      } else if (trimmed.startsWith('zemdomu-enable')) {
        ignoreBlock = false;
      }
      return;
    }

    if (node.type === 'text') {
      if (ignoreBlock) return;
      const trimmed = node.text.trim();
      if (anchorStack.length && trimmed) anchorStack[anchorStack.length - 1].foundText = true;
      if (emptyStack.length && trimmed) emptyStack[emptyStack.length - 1].foundText = true;
      if (buttonStack.length && trimmed) buttonStack[buttonStack.length - 1].foundText = true;
      return;
    }

    // element
    const tag = node.tagName.toLowerCase();
    const pos = getPos(node.startIndex);
    tagStack.push({ tag, line: pos.line, column: pos.column });

    if (ignoreNext) { ignoreNext = false; tagStack.pop(); return; }
    if (ignoreBlock) {
      node.children.forEach(traverse);
      tagStack.pop();
      return;
    }

    // labels
    if (tag === 'label' && node.attrs['for']) labels.add(node.attrs['for']);

    // structural tags
    if (tag === 'nav') navStack.push({ line: pos.line, column: pos.column, hasLink: false });
    if (tag === 'a' && navStack.length) navStack[navStack.length - 1].hasLink = true;

    if (options.rules.uniqueIds && node.attrs.id) {
      const idVal = String(node.attrs.id);
      if (ids.has(idVal)) {
        results.push({ ...pos, message: `Duplicate id "${idVal}"`, rule: 'uniqueIds' });
      } else {
        ids.set(idVal, { line: pos.line, column: pos.column });
      }
    }

    if (options.rules.requireHtmlLang && tag === 'html' && !htmlSeen) {
      htmlSeen = true;
      const lang = node.attrs.lang;
      if (lang === undefined) {
        results.push({ ...pos, message: '<html> element missing lang attribute', rule: 'requireHtmlLang' });
      } else if (!String(lang).trim()) {
        results.push({ ...pos, message: '<html> lang attribute is empty', rule: 'requireHtmlLang' });
      }
    }

    if (options.rules.requireIframeTitle && tag === 'iframe') {
      const title = node.attrs.title;
      if (title === undefined) {
        results.push({ ...pos, message: '<iframe> missing title attribute', rule: 'requireIframeTitle' });
      } else if (!String(title).trim()) {
        results.push({ ...pos, message: '<iframe> title attribute is empty', rule: 'requireIframeTitle' });
      }
    }

    if (options.rules.requireImageInputAlt && tag === 'input' && node.attrs.type && node.attrs.type.toLowerCase() === 'image') {
      const alt = node.attrs.alt;
      if (alt === undefined) {
        results.push({ ...pos, message: '<input type="image"> missing alt attribute', rule: 'requireImageInputAlt' });
      } else if (!String(alt).trim()) {
        results.push({ ...pos, message: '<input type="image"> alt attribute is empty', rule: 'requireImageInputAlt' });
      }
    }

    if (options.rules.requireLabelForFormControls && ['input','select','textarea'].includes(tag)) {
      const id = node.attrs.id;
      const aria = node.attrs['aria-label'];
      if (!aria || !aria.trim()) {
        if (!id) results.push({ ...pos, message: 'Form control missing id or aria-label', rule: 'requireLabelForFormControls' });
        else if (!labels.has(id)) results.push({ ...pos, message: `Form control with id="${id}" missing <label for=\"${id}\">`, rule: 'requireLabelForFormControls' });
      }
    }

    if (options.rules.singleH1 && tag === 'h1') {
      h1Count++;
      if (h1Count > 1) results.push({ ...pos, message: 'Only one <h1> allowed per document', rule: 'singleH1' });
    }

    if (options.rules.enforceHeadingOrder && /^h[1-6]$/.test(tag)) {
      const lvl = parseInt(tag.charAt(1), 10);
      if (lastHeadingLevel && lvl > lastHeadingLevel + 1) {
        results.push({ ...pos, message: `Heading level skipped: <${tag}> after <h${lastHeadingLevel}>`, rule: 'enforceHeadingOrder' });
      }
      lastHeadingLevel = lvl;
      if (sectionStack.length) sectionStack[sectionStack.length - 1].foundHeading = true;
    }

    if (options.rules.requireAltText && tag === 'img') {
      const alt = node.attrs.alt;
      if (alt === undefined) {
        results.push({ ...pos, message: '<img> tag missing alt attribute', rule: 'requireAltText' });
      } else if (!alt.trim()) {
        results.push({ ...pos, message: '<img> alt attribute is empty', rule: 'requireAltText' });
      }
    }

    if (options.rules.enforceListNesting && tag === 'li') {
      const parent = tagStack[tagStack.length - 2];
      if (!parent || !['ul','ol'].includes(parent.tag)) {
        results.push({ ...pos, message: '<li> must be inside a <ul> or <ol>', rule: 'enforceListNesting' });
      }
    }

    if (tag === 'a') {
      anchorStack.push({ ...pos, foundText: false });
      if (options.rules.requireHrefOnAnchors) {
        const href = node.attrs.href;
        if (!href || !href.trim()) results.push({ ...pos, message: '<a> tag missing non-empty href attribute', rule: 'requireHrefOnAnchors' });
      }
    }

    if (options.rules.requireButtonText && tag === 'button') {
      const aria = node.attrs['aria-label'];
      buttonStack.push({
        ...pos,
        foundText: !!(aria && aria.trim()),
        hadEmptyAria: aria !== undefined && !String(aria).trim()
      });
    }

    if (tag === 'table') tableStack.push({ ...pos, foundCaption: false });
    if (tag === 'caption' && tableStack.length) tableStack[tableStack.length - 1].foundCaption = true;

    if (options.rules.preventEmptyInlineTags && inlineTags.has(tag)) emptyStack.push({ ...pos, tag, foundText: false });

    if (options.rules.requireSectionHeading && tag === 'section') sectionStack.push({ ...pos, foundHeading: false });

    node.children.forEach(traverse);

    // closing tag logic
    if (ignoreBlock) {
      tagStack.pop();
      return;
    }

    if (options.rules.preventEmptyInlineTags && inlineTags.has(tag)) {
      const e = emptyStack.pop();
      if (e && !e.foundText) results.push({ line: e.line, column: e.column, message: `<${tag}> tag should not be empty`, rule: 'preventEmptyInlineTags' });
    }

    if (options.rules.requireLinkText && tag === 'a') {
      const a = anchorStack.pop();
      if (a && !a.foundText) results.push({ line: a.line, column: a.column, message: '<a> tag missing link text', rule: 'requireLinkText' });
    }

    if (tag === 'nav') {
      const n = navStack.pop();
      if (n && options.rules.requireNavLinks && !n.hasLink) {
        results.push({ line: n.line, column: n.column, message: '<nav> contains no links', rule: 'requireNavLinks' });
      }
    }

    if (options.rules.requireButtonText && tag === 'button') {
      const b = buttonStack.pop();
      if (b && !b.foundText) {
        if (b.hadEmptyAria) {
          results.push({ line: b.line, column: b.column, message: '<button> aria-label attribute is empty', rule: 'requireButtonText' });
        } else {
          results.push({ line: b.line, column: b.column, message: '<button> missing accessible text', rule: 'requireButtonText' });
        }
      }
    }

    if (options.rules.requireSectionHeading && tag === 'section') {
      const s = sectionStack.pop();
      if (s && !s.foundHeading) results.push({ line: s.line, column: s.column, message: '<section> missing heading (<h1>-<h6>)', rule: 'requireSectionHeading' });
    }

    if (options.rules.requireTableCaption && tag === 'table') {
      const tEntry = tableStack.pop();
      if (tEntry && !tEntry.foundCaption) results.push({ line: tEntry.line, column: tEntry.column, message: '<table> missing <caption>', rule: 'requireTableCaption' });
    }

    tagStack.pop();
  }

  root.children.forEach(traverse);

  if (options.rules.requireNavLinks) {
    while (navStack.length) {
      const n = navStack.pop();
      if (n && !n.hasLink) results.push({ line: n.line, column: n.column, message: '<nav> contains no links', rule: 'requireNavLinks' });
    }
  }



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
    const buttonStack: Array<{ foundText: boolean; line: number; column: number; hadEmptyAria: boolean }> = [];
    const tableStack: Array<{ foundCaption: boolean; line: number; column: number }> = [];
    const emptyStack: Array<{ tag: string; foundText: boolean; line: number; column: number }> = [];
    const labels = new Set<string>();
    let htmlSeen = false;
    const navStack: Array<{ line: number; column: number; hasLink: boolean }> = [];
    const ids = new Map<string, { line: number; column: number }>();

    traverse(ast, {
      JSXElement: {
        enter(path: NodePath<JSXElement>) {
          const opening = path.node.openingElement;
          if (!isJSXIdentifier(opening.name)) return;
          const tag = opening.name.name.toLowerCase();
          const loc = opening.loc?.start;
          if (!loc) return;
          const pos = { line: loc.line - 1, column: loc.column };
          if (isIgnored(loc.line)) return;

          // labels
          opening.attributes.forEach(attr => {
            if (isJSXAttribute(attr) && isJSXIdentifier(attr.name) && attr.name.name === 'for') {
              if (isStringLiteral(attr.value)) labels.add(attr.value.value);
            }
          });

          if (tag === 'nav') navStack.push({ line: pos.line, column: pos.column, hasLink: false });
          if (tag === 'a' && navStack.length) navStack[navStack.length - 1].hasLink = true;

          if (options.rules.uniqueIds) {
            let idLiteral: string | undefined;
            opening.attributes.forEach(attr => {
              if (isJSXAttribute(attr) && isJSXIdentifier(attr.name) && attr.name.name === 'id' && isStringLiteral(attr.value)) {
                idLiteral = attr.value.value;
              }
            });
            if (idLiteral) {
              if (ids.has(idLiteral)) {
                results.push({ ...pos, message: `Duplicate id "${idLiteral}"`, rule: 'uniqueIds' });
              } else {
                ids.set(idLiteral, { line: pos.line, column: pos.column });
              }
            }
          }

          if (options.rules.requireHtmlLang && tag === 'html' && !htmlSeen) {
            htmlSeen = true;
            const hasLang = opening.attributes.some(attr =>
              isJSXAttribute(attr) &&
              isJSXIdentifier(attr.name) &&
              attr.name.name === 'lang' &&
              isStringLiteral(attr.value) && attr.value.value.trim() !== ''
            );
            if (!hasLang) {
              results.push({ ...pos, message: '<html> element missing lang attribute', rule: 'requireHtmlLang' });
            }
          }

          if (options.rules.requireIframeTitle && tag === 'iframe') {
            const hasTitle = opening.attributes.some(attr =>
              isJSXAttribute(attr) &&
              isJSXIdentifier(attr.name) &&
              attr.name.name === 'title' &&
              isStringLiteral(attr.value) && attr.value.value.trim() !== ''
            );
            if (!hasTitle) {
              results.push({ ...pos, message: '<iframe> missing title attribute', rule: 'requireIframeTitle' });
            }
          }

          if (options.rules.requireImageInputAlt && tag === 'input') {
            let isImage = false;
            let altVal: string | undefined;
            opening.attributes.forEach(attr => {
              if (isJSXAttribute(attr) && isJSXIdentifier(attr.name)) {
                if (attr.name.name === 'type' && isStringLiteral(attr.value)) {
                  isImage = attr.value.value.toLowerCase() === 'image';
                }
                if (attr.name.name === 'alt' && isStringLiteral(attr.value)) {
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
              if (isJSXAttribute(attr) && isJSXIdentifier(attr.name)) {
                if (attr.name.name === 'id' && isStringLiteral(attr.value)) idVal = attr.value.value;
                if (attr.name.name === 'aria-label' && isStringLiteral(attr.value)) ariaVal = attr.value.value;
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
            let altAttr: JSXAttribute | undefined;
            opening.attributes.forEach(attr => {
              if (isJSXAttribute(attr) && isJSXIdentifier(attr.name) && attr.name.name === 'alt') {
                altAttr = attr;
              }
            });
            if (!altAttr) {
              results.push({ ...pos, message: '<img> tag missing alt attribute', rule: 'requireAltText' });
            } else if (!isStringLiteral(altAttr.value) || altAttr.value.value.trim() === '') {
              results.push({ ...pos, message: '<img> alt attribute is empty', rule: 'requireAltText' });
            }
          }
          
          // li nesting
          if (options.rules.enforceListNesting && tag === 'li') {
            const parent = path.parentPath?.node as JSXElement;
            if (isJSXElement(parent)) {
              const p = parent.openingElement.name;
              if (isJSXIdentifier(p)) {
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
                isJSXAttribute(a) &&
                isJSXIdentifier((a as JSXAttribute).name) &&
                (a as JSXAttribute).name.name === 'href'
              ) as JSXAttribute | undefined;

              if (!hrefVal || !isStringLiteral(hrefVal.value) || !hrefVal.value.value.trim()) {
                results.push({ ...pos, message: '<a> tag missing non-empty href attribute', rule: 'requireHrefOnAnchors' });
              }
            }
          }

          if (options.rules.requireButtonText && tag === 'button') {
            let hasAria = false;
            let emptyAria = false;
            opening.attributes.forEach(attr => {
              if (isJSXAttribute(attr) && isJSXIdentifier(attr.name) && attr.name.name === 'aria-label' && isStringLiteral(attr.value)) {
                if (attr.value.value.trim()) hasAria = true;
                else emptyAria = true;
              }
            });
            buttonStack.push({ ...pos, foundText: hasAria, hadEmptyAria: emptyAria });
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
        exit(path: NodePath<JSXElement>) {
          const opening = path.node.openingElement;
          if (!isJSXIdentifier(opening.name) || !opening.loc) return;
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

          if (tag === 'nav') {
            const n = navStack.pop();
            if (n && options.rules.requireNavLinks && !n.hasLink) {
              results.push({ ...n, message: '<nav> contains no links', rule: 'requireNavLinks' });
            }
          }

          if (options.rules.requireButtonText && tag === 'button') {
            const b = buttonStack.pop();
            if (b && !b.foundText) {
              if (b.hadEmptyAria) {
                results.push({ ...b, message: '<button> aria-label attribute is empty', rule: 'requireButtonText' });
              } else {
                results.push({ ...b, message: '<button> missing accessible text', rule: 'requireButtonText' });
              }
            }
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

    if (options.rules.requireNavLinks) {
      while (navStack.length) {
        const n = navStack.pop();
        if (n && !n.hasLink) results.push({ ...n, message: '<nav> contains no links', rule: 'requireNavLinks' });
      }
    }

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