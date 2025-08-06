import { Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TokenIndex, TokenData } from './scanner';
import { Project, SyntaxKind, Node } from 'ts-morph';
import * as ts from 'typescript';

export function getWordAtPosition(doc: TextDocument, position: Position): string {
  const text = doc.getText();
  const offset = doc.offsetAt(position);
  let start = offset, end = offset;
  while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
  while (end < text.length && /[\w$]/.test(text[end])) end++;
  return text.slice(start, end);
}

export function getTokenPropertyAtPosition(
  doc: TextDocument,
  position: Position
): string | null {
  const line = doc.getText({ start: { line: position.line, character: 0 }, end: { line: position.line + 1, character: 0 } });
  const re = /\b(?:\w+\.)*token\.(\w+)\b/g;
  let m;
  while ((m = re.exec(line))) {
    const prop = m[1], idx = m.index + m[0].lastIndexOf(prop);
    if (position.character >= idx && position.character <= idx + prop.length) return prop;
  }
  return null;
}

export function resolveLocalTokenAtPosition(
  uri: string,
  content: string,
  pos: Position,
  name: string
): string | undefined {
  try {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile(uri, content);

    const offset = sf.compilerNode.getPositionOfLineAndCharacter(pos.line, pos.character);
    const node = sf.getDescendantAtPos(offset);

    if (!node || node.getText() !== name) return;

    const symbol = node.getSymbol();
    if (!symbol) return;

    const decl = symbol.getDeclarations().find(d => d.getKind() === SyntaxKind.VariableDeclaration);
    if (!decl || !Node.isVariableDeclaration(decl)) return;

    const initializer = decl.getInitializer();
    if (!initializer) return;

    const kind = initializer.getKind();
    if (
      kind === SyntaxKind.StringLiteral ||
      kind === SyntaxKind.NumericLiteral ||
      kind === SyntaxKind.Identifier
    ) {
      return initializer.getText();
    }

    return;
  } catch (err) {
    console.error('resolveLocalTokenAtPosition error:', err);
    return undefined;
  }
}


export function resolveFullTokenValueAtPosition(
  name: string,
  content: string,
  pos: Position
): string[] | null {
  const sf = ts.createSourceFile('temp.tsx', content, ts.ScriptTarget.Latest, true);
  const offset = sf.getPositionOfLineAndCharacter(pos.line, pos.character);
  const results: string[] = [];

  const visitor = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === name &&
      offset >= node.getStart() &&
      offset <= node.getEnd()
    ) {
      const chain: string[] = [];
      let cur: ts.Expression = node;
      while (ts.isPropertyAccessExpression(cur)) {
        chain.unshift(cur.name.text);
        cur = cur.expression;
      }
      if (ts.isIdentifier(cur)) chain.unshift(cur.text);

      let val: any = null;
      const finder = (n: ts.Node) => {
        if (
          ts.isVariableDeclaration(n) &&
          ts.isIdentifier(n.name) &&
          n.name.text === chain[0] &&
          n.initializer && ts.isObjectLiteralExpression(n.initializer)
        ) {
          let obj: any = n.initializer;
          for (const key of chain.slice(1)) {
            const prop = obj.properties.find(
              (p: any) => p.name.text === key
            );
            if (!prop) return;
            obj = prop.initializer;
          }
          if (ts.isStringLiteral(obj) || ts.isNumericLiteral(obj)) val = obj.text;
        }
        ts.forEachChild(n, finder);
      };
      finder(sf);
      if (val) results.push(val);
    }
    ts.forEachChild(node, visitor);
  };
  visitor(sf);
  return results.length ? results : null;
}

export interface ContextualTokenMatch {
  tokenData: TokenData;
  confidence: number;
}

export function resolveTokenInContext(
  doc: TextDocument,
  pos: Position,
  name: string,
  index: TokenIndex,
  content: string
): ContextualTokenMatch[] {
  const _sf = ts.createSourceFile(doc.uri, content, ts.ScriptTarget.Latest, true);
  const defs = index.get(name) || [];
  return defs.map(td => ({ tokenData: td, confidence: 20 }));
}
