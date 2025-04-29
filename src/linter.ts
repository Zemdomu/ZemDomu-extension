// src/linter.ts
import { Parser } from 'htmlparser2';
import { parse } from '@babel/parser';
import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

export interface LintResult {
  line: number;
  column: number;
  message: string;
}

/**
 * Lint HTML or JSX/TSX content for semantic issues.
 * @param content The file content
 * @param xmlMode true to parse as JSX/TSX, false for plain HTML
 */
export function lintHtml(content: string, xmlMode = false): LintResult[] {
  return xmlMode ? lintJsx(content) : lintHtmlString(content);
}

// === Plain HTML branch using htmlparser2 ===
function lintHtmlString(html: string): LintResult[] {
  const results: LintResult[] = [];
  const tagStack: Array<{ tag: string; line: number; column: number }> = [];
  let lastHeadingLevel = 0;
  let h1Count = 0;
  const sectionStack: Array<{ foundHeading: boolean; line: number; column: number }> = [];
  const anchorStack: Array<{ foundText: boolean; line: number; column: number }> = [];
  const tableStack: Array<{ foundCaption: boolean; line: number; column: number }> = [];
  const emptyStack: Array<{ tag: string; foundText: boolean; line: number; column: number }> = [];
  const labels = new Set<string>();
  let ignoreNext = false;
  let curLine = 0;
  let curCol = 0;
  const inlineTags = new Set(['strong','em','b','i','u','small','mark','del','ins']);

  const parser = new Parser({
    oncomment(data) {
      if (data.trim().startsWith('zemdomu-disable-next')) ignoreNext = true;
    },
    ontext(text) {
      const parts = text.split('\n');
      if (parts.length > 1) {
        curLine += parts.length - 1;
        curCol = parts[parts.length - 1].length;
      } else {
        curCol += text.length;
      }
      const trimmed = text.trim();
      if (anchorStack.length && trimmed) anchorStack[anchorStack.length - 1].foundText = true;
      if (emptyStack.length && trimmed) emptyStack[emptyStack.length - 1].foundText = true;
    },
    onopentag(name, attrs) {
      const tag = name.toLowerCase();
      const pos = { tag, line: curLine, column: curCol };
      tagStack.push(pos);
      if (ignoreNext) { ignoreNext = false; return; }

      // labels
      if (tag === 'label' && attrs.for) labels.add(attrs.for);
      // form controls
      if (['input','select','textarea'].includes(tag)) {
        const id = attrs.id;
        const aria = attrs['aria-label'];
        if (!aria || !aria.trim()) {
          if (!id) results.push({ ...pos, message: 'Form control missing id or aria-label' });
          else if (!labels.has(id)) results.push({ ...pos, message: `Form control with id="${id}" missing <label for=\"${id}\">` });
        }
      }
      // only one h1
      if (tag === 'h1') {
        h1Count++;
        if (h1Count > 1) results.push({ ...pos, message: 'Only one <h1> allowed per document' });
      }
      // heading order
      if (/^h[1-6]$/.test(tag)) {
        const lvl = parseInt(tag.charAt(1), 10);
        if (lastHeadingLevel && lvl > lastHeadingLevel + 1) {
          results.push({ ...pos, message: `Heading level skipped: <${tag}> after <h${lastHeadingLevel}>` });
        }
        lastHeadingLevel = lvl;
        if (sectionStack.length) sectionStack[sectionStack.length - 1].foundHeading = true;
      }
      // img alt
      if (tag === 'img') {
        const alt = attrs.alt;
        if (!alt || !alt.trim()) results.push({ ...pos, message: '<img> tag missing non-empty alt attribute' });
      }
      // li nesting
      if (tag === 'li') {
        const parent = tagStack[tagStack.length - 2];
        if (!parent || !['ul','ol'].includes(parent.tag)) {
          results.push({ ...pos, message: '<li> must be inside a <ul> or <ol>' });
        }
      }
      // anchor
      if (tag === 'a') {
        anchorStack.push({ ...pos, foundText: false });
        const href = attrs.href;
        if (!href || !href.trim()) results.push({ ...pos, message: '<a> tag missing non-empty href attribute' });
      }
      // table caption
      if (tag === 'table') tableStack.push({ ...pos, foundCaption: false });
      if (tag === 'caption' && tableStack.length) tableStack[tableStack.length - 1].foundCaption = true;
      // empty inline
      if (inlineTags.has(tag)) emptyStack.push({ ...pos, foundText: false });
      // section heading
      if (tag === 'section') sectionStack.push({ ...pos, foundHeading: false });
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      tagStack.pop();
      if (inlineTags.has(tag)) {
        const e = emptyStack.pop();
        if (e && !e.foundText) results.push({ line: e.line, column: e.column, message: `<${tag}> tag should not be empty` });
      }
      if (tag === 'a') {
        const a = anchorStack.pop();
        if (a && !a.foundText) results.push({ line: a.line, column: a.column, message: '<a> tag missing link text' });
      }
      if (tag === 'section') {
        const s = sectionStack.pop();
        if (s && !s.foundHeading) results.push({ line: s.line, column: s.column, message: '<section> missing heading (<h1>-<h6>)' });
      }
      if (tag === 'table') {
        const t = tableStack.pop();
        if (t && !t.foundCaption) results.push({ line: t.line, column: t.column, message: '<table> missing <caption>' });
      }
    }
  }, { decodeEntities: true, xmlMode: false, recognizeSelfClosing: true });

  parser.write(html);
  parser.end();
  return results;
}

// === JSX/TSX branch using Babel ===
function lintJsx(code: string): LintResult[] {
  const results: LintResult[] = [];
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });

  let lastHeadingLevel = 0;
  let h1Count = 0;
  const sectionStack: Array<{ foundHeading: boolean; line: number; column: number }> = [];
  const anchorStack: Array<{ foundText: boolean; line: number; column: number }> = [];
  const tableStack: Array<{ foundCaption: boolean; line: number; column: number }> = [];
  const emptyStack: Array<{ tag: string; foundText: boolean; line: number; column: number }> = [];
  const labels = new Set<string>();

  traverse(ast, {
    JSXElement: {
      enter(path: NodePath<t.JSXElement>) {
        const opening = path.node.openingElement;
        if (!t.isJSXIdentifier(opening.name)) return;
        const tag = opening.name.name.toLowerCase();
        const loc = opening.loc?.start;
        if (!loc) return;
        const pos = { line: loc.line - 1, column: loc.column };

        // labels
        opening.attributes.forEach(attr => {
          if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === 'for') {
            if (t.isStringLiteral(attr.value)) labels.add(attr.value.value);
          }
        });
        // form controls
        if (['input', 'select', 'textarea'].includes(tag)) {
          let idVal: string | undefined;
          let ariaVal: string | undefined;
          opening.attributes.forEach(attr => {
            if (t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name)) {
              if (attr.name.name === 'id' && t.isStringLiteral(attr.value)) idVal = attr.value.value;
              if (attr.name.name === 'aria-label' && t.isStringLiteral(attr.value)) ariaVal = attr.value.value;
            }
          });
          if (!ariaVal || !ariaVal.trim()) {
            if (!idVal) results.push({ ...pos, message: 'Form control missing id or aria-label' });
            else if (!labels.has(idVal)) results.push({ ...pos, message: `Form control with id="${idVal}" missing <label for=\"${idVal}\">` });
          }
        }
        // only one h1
        if (tag === 'h1') { h1Count++; if (h1Count > 1) results.push({ ...pos, message: 'Only one <h1> allowed per document' }); }
        // heading order
        if (/^h[1-6]$/.test(tag)) {
          const lvl = parseInt(tag.charAt(1), 10);
          if (lastHeadingLevel && lvl > lastHeadingLevel + 1) results.push({ ...pos, message: `Heading level skipped: <${tag}> after <h${lastHeadingLevel}>` });
          lastHeadingLevel = lvl;
          if (sectionStack.length) sectionStack[sectionStack.length - 1].foundHeading = true;
        }
        // img alt
        if (tag === 'img') {
          const hasAlt = opening.attributes.some(attr =>
            t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.name) && attr.name.name === 'alt' &&
            t.isStringLiteral(attr.value) && attr.value.value.trim() !== ''
          );
          if (!hasAlt) results.push({ ...pos, message: '<img> missing non-empty alt attribute' });
        }
        // li nesting
        if (tag === 'li') {
          const parent = path.parentPath?.node as t.JSXElement;
          if (t.isJSXElement(parent)) {
            const p = parent.openingElement.name;
            if (t.isJSXIdentifier(p)) {
              const pTag = p.name.toLowerCase();
              if (!['ul', 'ol'].includes(pTag)) results.push({ ...pos, message: '<li> must be inside a <ul> or <ol>' });
            }
          }
        }
        // anchors
        if (tag === 'a') { anchorStack.push({ ...pos, foundText: false });
          const hrefVal = opening.attributes.find(a => t.isJSXAttribute(a) && t.isJSXIdentifier((a as t.JSXAttribute).name) && (a as t.JSXAttribute).name.name === 'href') as t.JSXAttribute | undefined;
          if (!hrefVal || !t.isStringLiteral(hrefVal.value) || !hrefVal.value.value.trim()) results.push({ ...pos, message: '<a> tag missing non-empty href attribute' });
        }
        // table caption
        if (tag === 'table') tableStack.push({ ...pos, foundCaption: false });
        if (tag === 'caption' && tableStack.length) tableStack[tableStack.length - 1].foundCaption = true;
        // empty inline
        if (['strong','em','b','i','u','small','mark','del','ins'].includes(tag)) emptyStack.push({ ...pos, tag, foundText: false });
        // section
        if (tag === 'section') sectionStack.push({ ...pos, foundHeading: false });
      },
      exit(path: NodePath<t.JSXElement>) {
        const opening = path.node.openingElement;
        if (!t.isJSXIdentifier(opening.name) || !opening.loc) return;
        const tag = opening.name.name.toLowerCase();
        const pos = { line: opening.loc.start.line - 1, column: opening.loc.start.column };
        if (['strong','em','b','i','u','small','mark','del','ins'].includes(tag)) {
          const e = emptyStack.pop(); if (e && !e.foundText) results.push({ ...e, message: `<${tag}> tag should not be empty` });
        }
        if (tag === 'a') { const a = anchorStack.pop(); if (a && !a.foundText) results.push({ ...a, message: '<a> tag missing link text' }); }
        if (tag === 'section') { const s = sectionStack.pop(); if (s && !s.foundHeading) results.push({ ...s, message: '<section> missing heading (<h1>-<h6>)' }); }
        if (tag === 'table') { const tble = tableStack.pop(); if (tble && !tble.foundCaption) results.push({ ...tble, message: '<table> missing <caption>' }); }
      }
    }
  });

  return results;
}
