import { Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import ts from "typescript";

export function getWordAtPosition(doc: TextDocument, position: Position): string {
  const line = doc.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 }
  });

  // Match camelCase, kebab-case, or dot.notation
  const regex = /[\w-]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return match[0];
    }
  }

  return '';
}

// -------------------------------------------------
// local token resolution helpers

export function resolveFullTokenValueAtPosition(
  word: string,
  fileContent: string,
  position: Position
): string | null {
  const sourceFile = ts.createSourceFile(
    "temp.ts",
    fileContent,
    ts.ScriptTarget.Latest,
    true
  );
  const offset = sourceFile.getPositionOfLineAndCharacter(
    position.line,
    position.character
  );

  let result: string | null = null;

  function visit(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === word) {
      if (offset >= node.getStart() && offset <= node.getEnd()) {
        const chain = getAccessChain(node);
        result = resolveChainValue(sourceFile, chain);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return result;
}

function getAccessChain(node: ts.PropertyAccessExpression): string[] {
  const chain: string[] = [];
  let current: ts.Expression = node;

  while (ts.isPropertyAccessExpression(current)) {
    chain.unshift(current.name.text);
    current = current.expression;
  }

  if (ts.isIdentifier(current)) {
    chain.unshift(current.text);
  }

  return chain;
}

function resolveChainValue(
  sourceFile: ts.SourceFile,
  chain: string[]
): string | null {
  const [rootName, ...rest] = chain;

  let value: any = null;

  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === rootName &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      value = resolveObjectValue(node.initializer, rest);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return typeof value === "string" ? value : null;
}

function resolveObjectValue(
  obj: ts.ObjectLiteralExpression,
  chain: string[]
): string | object | null {
  let current: ts.Expression = obj;

  for (const key of chain) {
    if (!ts.isObjectLiteralExpression(current)) return null;
    const prop = current.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === key
    );
    if (!prop) return null;
    current = prop.initializer;
  }

  if (ts.isStringLiteral(current)) {
    return current.text;
  } else if (ts.isObjectLiteralExpression(current)) {
    return "[object]";
  }
  return null;
}