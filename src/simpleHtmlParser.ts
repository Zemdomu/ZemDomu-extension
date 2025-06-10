export type Node = ElementNode | TextNode | CommentNode;

export interface ElementNode {
  type: 'element';
  tagName: string;
  attrs: Record<string, string>;
  children: Node[];
  startIndex: number;
  selfClosing?: boolean;
}

export interface TextNode {
  type: 'text';
  text: string;
  startIndex: number;
}

export interface CommentNode {
  type: 'comment';
  text: string;
  startIndex: number;
}

interface Token {
  type: 'open' | 'close' | 'text' | 'comment';
  tag?: string;
  attrs?: Record<string, string>;
  selfClosing?: boolean;
  text?: string;
  index: number;
}

function parseAttributes(str: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  str.replace(/([\w-:]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g, (_, name: string, value: string) => {
    if (value === undefined) {
      attrs[name] = '';
    } else {
      attrs[name] = value.replace(/^['"]|['"]$/g, '');
    }
    return '';
  });
  return attrs;
}

function* tokenize(html: string): Generator<Token> {
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const text = html.slice(i + 4, end === -1 ? html.length : end);
      yield { type: 'comment', text, index: i };
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[i] === '<') {
      const close = html.slice(i).match(/^<\/(\s*[\w-:]+)\s*>/);
      if (close) {
        yield { type: 'close', tag: close[1].trim().toLowerCase(), index: i };
        i += close[0].length;
        continue;
      }
      const open = html.slice(i).match(/^<\s*([\w-:]+)([^>]*?)(\/)?>/);
      if (open) {
        const [, tag, attrs, self] = open;
        yield {
          type: 'open',
          tag: tag.toLowerCase(),
          attrs: parseAttributes(attrs),
          selfClosing: !!self,
          index: i
        };
        i += open[0].length;
        continue;
      }
    }
    const next = html.indexOf('<', i);
    const end = next === -1 ? html.length : next;
    const text = html.slice(i, end);
    yield { type: 'text', text, index: i };
    i = end;
  }
}

export function parse(html: string): ElementNode {
  const root: ElementNode = { type: 'element', tagName: 'root', attrs: {}, children: [], startIndex: 0 };
  const stack: ElementNode[] = [root];
  for (const token of tokenize(html)) {
    const parent = stack[stack.length - 1];
    if (token.type === 'open') {
      const node: ElementNode = { type: 'element', tagName: token.tag!, attrs: token.attrs || {}, children: [], startIndex: token.index, selfClosing: token.selfClosing };
      parent.children.push(node);
      if (!token.selfClosing) stack.push(node);
    } else if (token.type === 'close') {
      if (stack.length > 1) stack.pop();
    } else if (token.type === 'text') {
      parent.children.push({ type: 'text', text: token.text || '', startIndex: token.index });
    } else if (token.type === 'comment') {
      parent.children.push({ type: 'comment', text: token.text || '', startIndex: token.index });
    }
  }
  return root;
}
