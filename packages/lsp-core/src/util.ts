import { Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TokenIndex } from './scanner';
import ts from "typescript";

export function getAllTokenURIs(tokenIndex: TokenIndex): string[] {
  const uris = new Set<string>();

  for (const tokenList of Array.from(tokenIndex.values())) {
    for (const tokenData of tokenList) {
      if (tokenData.uri) {
        uris.add(tokenData.uri);
      }
    }
  }

  return Array.from(uris);
}

export function getWordAtPosition(doc: TextDocument, position: Position): string {
  const text = doc.getText();
  const offset = doc.offsetAt(position);

  // Expand left until you hit a non-identifier character
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) {
    start--;
  }

  // Expand right in the same way
  let end = offset;
  while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) {
    end++;
  }

  return text.slice(start, end);
}

/**
 * If you’re hovering on “token.foo” or “theme.token.foo”, return “foo”
 */
export function getTokenPropertyAtPosition(
  doc: TextDocument,
  position: Position
): string | null {
  const lineText = doc.getText({
    start: { line: position.line, character: 0 },
    end:   { line: position.line + 1, character: 0 },
  });

  // Look for token-access anywhere on this line
  // Captures foo in either token.foo or theme.token.foo
  const re = /\b(?:\w+\.)*token\.(\w+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText))) {
    const prop = m[1];
    const propStart = m.index + m[0].lastIndexOf(prop);
    const propEnd   = propStart + prop.length;

    if (
      position.character >= propStart &&
      position.character <= propEnd
    ) {
      return prop;
    }
  }

  return null;
}

// -------------------------------------------------
// Enhanced local token resolution helpers

export function resolveFullTokenValueAtPosition(
  word: string,
  fileContent: string,
  position: Position
): string[] | null {
  const sourceFile = ts.createSourceFile(
    "temp.tsx", // Use .tsx to handle JSX properly
    fileContent,
    ts.ScriptTarget.Latest,
    true
  );
  
  const offset = sourceFile.getPositionOfLineAndCharacter(
    position.line,
    position.character
  );

  const results: string[] = [];

  function visit(node: ts.Node) {
    // Handle property access expressions (e.g., token.colorPrimary)
    if (ts.isPropertyAccessExpression(node) && node.name.text === word) {
      if (offset >= node.getStart() && offset <= node.getEnd()) {
        const chain = getAccessChain(node);
        const resolvedValue = resolveChainValue(sourceFile, chain);
        if (resolvedValue) {
          results.push(resolvedValue);
        }
      }
    }
    
    // Handle JSX attribute expressions
    if (ts.isJsxExpression(node) && node.expression) {
      if (ts.isPropertyAccessExpression(node.expression) && 
          node.expression.name.text === word &&
          offset >= node.getStart() && offset <= node.getEnd()) {
        const chain = getAccessChain(node.expression);
        const resolvedValue = resolveChainValue(sourceFile, chain);
        if (resolvedValue) {
          results.push(resolvedValue);
        }
      }
    }
    
    // Handle template literal expressions
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        if (ts.isPropertyAccessExpression(span.expression) && 
            span.expression.name.text === word &&
            offset >= span.getStart() && offset <= span.getEnd()) {
          const chain = getAccessChain(span.expression);
          const resolvedValue = resolveChainValue(sourceFile, chain);
          if (resolvedValue) {
            results.push(resolvedValue);
          }
        }
      }
    }

    // Handle useToken() and getToken() destructuring
    if (ts.isCallExpression(node) && 
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'useToken' || node.expression.text === 'getToken')) {
      
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && 
          ts.isObjectBindingPattern(parent.name)) {
        
        for (const element of parent.name.elements) {
          if (ts.isBindingElement(element) && 
              ts.isIdentifier(element.name) && 
              element.name.text === 'token') {
            
            // Look for usage of this token variable
            findTokenUsages(sourceFile, 'token', word, results);
          }
        }
      }
    }

    // Handle imported token usage (e.g., colorPrimary from imported JSON)
    if (ts.isIdentifier(node) && node.text === word) {
      if (offset >= node.getStart() && offset <= node.getEnd()) {
        // This could be an imported token, but we'll let the main hover logic handle it
        // by checking the token index for imported definitions
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return results.length > 0 ? results : null;
}

function findTokenUsages(
  sourceFile: ts.SourceFile, 
  tokenVarName: string, 
  propertyName: string, 
  results: string[]
) {
  function visit(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === tokenVarName &&
        node.name.text === propertyName) {
      
      // Try to find the actual value assignment
      const fullChain = `${tokenVarName}.${propertyName}`;
      results.push(fullChain);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
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
  } else if (ts.isNumericLiteral(current)) {
    return current.text; // Add this line
  } else if (ts.isObjectLiteralExpression(current)) {
    return "[object]";
  }
  return null;
}

import { TokenData } from './scanner';

export function findExactTokenDefinitionAtPosition(
  fileContent: string,
  position: Position,
  tokenName: string,
  tokenDefs: TokenData[],
  context?: string // <-- new optional parameter
): TokenData | undefined {
  const sourceFile = ts.createSourceFile('file.tsx', fileContent, ts.ScriptTarget.Latest, true);

  let foundNode: ts.Node | undefined;

  function findNodeAt(pos: ts.Node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos.getStart());
    if (line === position.line && character <= position.character && pos.getText() === tokenName) {
      foundNode = pos;
    }
    ts.forEachChild(pos, findNodeAt);
  }

  findNodeAt(sourceFile);

  // Prefer context match if provided
  if (context) {
    const contextDef = tokenDefs.find(d => d.context === context);
    if (contextDef) return contextDef;
  }

  if (!foundNode) return;

  const def = tokenDefs.find(d =>
    d.uri.endsWith('.ts') || d.uri.endsWith('.tsx') || d.uri.endsWith('.js') || d.uri.endsWith('.jsx')
  );

  return def ?? tokenDefs[0]; // fallback
}

import { Project } from "ts-morph";

export function resolveLocalTokenAtPosition(
  filePath: string,
  content: string,
  position: Position,
  tokenName: string
): string | undefined {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(filePath, content);

  const node = sourceFile.getDescendantAtPos(
    sourceFile.compilerNode.getPositionOfLineAndCharacter(position.line, position.character)
  );

  if (!node || node.getText() !== tokenName) return;

  const symbol = node.getSymbol();
  if (!symbol) return;

  const decls = symbol.getDeclarations();
  const varDecl = decls.find(d => d.getKindName() === "VariableDeclaration");

  if (!varDecl) return;

  // Cast to VariableDeclaration to access getInitializer()
  const valueNode = (varDecl as import("ts-morph").VariableDeclaration).getInitializer?.();
  if (!valueNode) return;

  // Only show literal values (string, number) or simple identifiers
  const kind = valueNode.getKindName();
  if (kind === "StringLiteral" || kind === "NumericLiteral" || kind === "Identifier") {
    return valueNode.getText();
  }

  return undefined;
}
