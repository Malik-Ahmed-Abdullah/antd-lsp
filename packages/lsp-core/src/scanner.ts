import ts from "typescript";
import fs from "fs/promises";
import path from "path";
import JSON5 from 'json5';
import { Project } from "ts-morph";
import type { Position } from "vscode-languageserver";

export type TokenName = string;

export type TokenData = {
  uri: string;
  value: string;
  position: Position;
  source: 'configProvider' | 'useToken' | 'getToken' | 'themeConfig' | 'json' | 'css';
  context?: string; // Additional context like component name or variable name
};

export type TokenIndex = Map<TokenName, TokenData[]>; // Changed to array to handle multiple definitions

const supportedExtensions = /\.(ts|tsx|js|jsx|json|css|less|scss)$/;
const ignoredDirs = ["node_modules", "dist", "build", ".git", ".next", "out"];

// Common Ant Design token names for better matching
const commonAntdTokens = new Set([
  'colorPrimary', 'colorSuccess', 'colorWarning', 'colorError', 'colorInfo',
  'colorTextBase', 'colorBgBase', 'colorText', 'colorTextSecondary',
  'borderRadius', 'borderRadiusLG', 'borderRadiusSM', 'borderRadiusXS',
  'fontSize', 'fontSizeLG', 'fontSizeSM', 'fontSizeXL',
  'lineHeight', 'lineHeightLG', 'lineHeightSM',
  'spacing', 'spacingXS', 'spacingSM', 'spacingLG', 'spacingXL',
  'controlHeight', 'controlHeightLG', 'controlHeightSM',
  'motionDurationSlow', 'motionDurationMid', 'motionDurationFast'
]);

export async function scanAndIndexTokens(
  rootUri: string,
  tokenIndex: TokenIndex
): Promise<void> {
  const files = await findAllFiles(rootUri);
  
  // Clear existing index
  tokenIndex.clear();
  
  await Promise.all(files.map(async (filePath) => {
    const content = await fs.readFile(filePath, "utf-8");
    if (/\.(ts|tsx|js|jsx)$/.test(filePath)) {
      await extractFromTsxTs(filePath, content, tokenIndex);
    } else if (filePath.endsWith(".json")) {
      await extractFromJson(filePath, content, tokenIndex);
    } else if (/\.(css|less|scss)$/.test(filePath)) {
      await extractFromCssLike(filePath, content, tokenIndex);
    }
  }));
}

async function findAllFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && ignoredDirs.includes(entry.name)) return [];
      if (entry.isDirectory()) return await findAllFiles(fullPath);
      if (entry.isFile() && supportedExtensions.test(fullPath)) return [fullPath];
      return [];
    })
  );
  return results.flat();
}

async function extractFromTsxTs(
  filePath: string,
  content: string,
  index: TokenIndex
) {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );

  // Extract from traditional ThemeConfig
  await extractFromThemeConfig(sourceFile, filePath, index);
  
  // Extract from ConfigProvider
  await extractFromConfigProvider(sourceFile, filePath, index);
  
  // Extract from useToken() and getToken() hooks
  //await _extractFromTokenHooks(sourceFile, filePath, index);
  
  // Extract token property accesses
  //await extractTokenPropertyAccess(sourceFile, filePath, index);

  // Use ts-morph for advanced extraction
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
    await extractWithTsMorph(filePath, content, index);
  }
}

async function extractWithTsMorph(
  filePath: string,
  content: string,
  index: TokenIndex
) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(filePath, content);

  sourceFile.forEachDescendant((node) => {
    if (node.getKindName() === "PropertyAssignment") {
      const prop = node.asKindOrThrow(ts.SyntaxKind.PropertyAssignment);
      const key = prop.getName();
      const valueNode = prop.getInitializer();

      if (!valueNode) return;

      const value = valueNode.getText();
      if (commonAntdTokens.has(key) || isLikelyTokenName(key)) {
        const pos = valueNode.getStartLinePos();
        const posInfo = sourceFile.getLineAndColumnAtPos(pos);
        addTokenToIndex(index, key, {
          uri: filePath,
          value,
          position: {
            line: posInfo.line - 1,
            character: posInfo.column - 1,
          },
          source: "themeConfig",
        });
      }
    } 
  });
}

async function extractFromThemeConfig(
  sourceFile: ts.SourceFile,
  filePath: string,
  index: TokenIndex
) {
  const themeIdentifiers = new Set<string>();

  function collectThemeVars(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.type &&
      ts.isTypeReferenceNode(node.type) &&
      ts.isIdentifier(node.type.typeName) &&
      node.type.typeName.text === "ThemeConfig" &&
      ts.isIdentifier(node.name)
    ) {
      themeIdentifiers.add(node.name.text);
    }
    ts.forEachChild(node, collectThemeVars);
  }

  function visit(node: ts.Node) {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "token"
    ) {
      const parentObj = node.parent;
      const maybeThemeVariable = parentObj.parent;

      if (
        ts.isObjectLiteralExpression(parentObj) &&
        ts.isVariableDeclaration(maybeThemeVariable) &&
        ts.isIdentifier(maybeThemeVariable.name) &&
        themeIdentifiers.has(maybeThemeVariable.name.text)
      ) {
        const tokenObject = node.initializer;

        if (ts.isObjectLiteralExpression(tokenObject)) {
          for (const prop of tokenObject.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
              const name = prop.name.text;
              const pos = sourceFile.getLineAndCharacterOfPosition(
                prop.name.getStart()
              );

              let value = extractValue(prop.initializer, sourceFile);

              addTokenToIndex(index, name, {
                uri: filePath,
                value,
                position: pos,
                source: 'themeConfig',
                context: maybeThemeVariable.name.text
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  collectThemeVars(sourceFile);
  visit(sourceFile);
}

async function extractFromConfigProvider(
  sourceFile: ts.SourceFile,
  filePath: string,
  index: TokenIndex
) {
  function visit(node: ts.Node) {
    // Look for <ConfigProvider theme={{...}} />
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = ts.isJsxElement(node) 
        ? node.openingElement.tagName 
        : node.tagName;
      
      if (ts.isIdentifier(tagName) && tagName.text === 'ConfigProvider') {
        const attributes = ts.isJsxElement(node) 
          ? node.openingElement.attributes.properties 
          : node.attributes.properties;
        
        for (const attr of attributes) {
          if (
            ts.isJsxAttribute(attr) &&
            ts.isIdentifier(attr.name) &&
            attr.name.text === 'theme' &&
            attr.initializer &&
            ts.isJsxExpression(attr.initializer) &&
            attr.initializer.expression
          ) {
            extractTokensFromThemeObject(
              attr.initializer.expression,
              sourceFile,
              filePath,
              index,
              'configProvider'
            );
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

async function _extractFromTokenHooks(
  sourceFile: ts.SourceFile,
  filePath: string,
  index: TokenIndex
) {
  function visit(node: ts.Node) {
    // Look for useToken() hook calls
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'useToken' || node.expression.text === 'getToken')
    ) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      
      // Check if it's part of destructuring assignment
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && parent.name) {
        if (ts.isObjectBindingPattern(parent.name)) {
          // const { token } = useToken()
          for (const element of parent.name.elements) {
            if (
              ts.isBindingElement(element) &&
              ts.isIdentifier(element.name) &&
              element.name.text === 'token'
            ) {
              // Mark this as a token object source
              addTokenToIndex(index, 'token', {
                uri: filePath,
                value: 'useToken().token',
                position: pos,
                source: node.expression.text === 'useToken' ? 'useToken' : 'getToken',
                context: 'hook'
              });
            }
          }
        } else if (ts.isIdentifier(parent.name)) {
          // const tokenObj = useToken()
          addTokenToIndex(index, parent.name.text, {
            uri: filePath,
            value: `${node.expression.text}()`,
            position: pos,
            source: node.expression.text === 'useToken' ? 'useToken' : 'getToken',
            context: 'hook'
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

async function _extractTokenPropertyAccess(
  sourceFile: ts.SourceFile,
  filePath: string,
  index: TokenIndex
) {
  function visit(node: ts.Node) {
    // Look for token.propertyName or tokenObj.token.propertyName
    if (ts.isPropertyAccessExpression(node)) {
      const chain = getPropertyAccessChain(node);
      
      // Check if this looks like token access
      if (isTokenAccess(chain)) {
        const tokenName = chain[chain.length - 1];
        const pos = sourceFile.getLineAndCharacterOfPosition(node.name.getStart());
        
        // Only add if it's a known Ant Design token or follows token pattern
        if (commonAntdTokens.has(tokenName) || isLikelyTokenName(tokenName)) {
          addTokenToIndex(index, tokenName, {
            uri: filePath,
            value: chain.join('.'),
            position: pos,
            source: 'useToken',
            context: 'property-access'
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function extractTokensFromThemeObject(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  filePath: string,
  index: TokenIndex,
  source: TokenData['source']
) {
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === 'token' &&
        ts.isObjectLiteralExpression(prop.initializer)
      ) {
        // Extract tokens from the token object
        for (const tokenProp of prop.initializer.properties) {
          if (ts.isPropertyAssignment(tokenProp) && ts.isIdentifier(tokenProp.name)) {
            const name = tokenProp.name.text;
            const pos = sourceFile.getLineAndCharacterOfPosition(
              tokenProp.name.getStart()
            );
            const value = extractValue(tokenProp.initializer, sourceFile);

            addTokenToIndex(index, name, {
              uri: filePath,
              value,
              position: pos,
              source,
              context: 'theme-object'
            });
          }
        }
      }
    }
  }
}

function getPropertyAccessChain(node: ts.PropertyAccessExpression): string[] {
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

function isTokenAccess(chain: string[]): boolean {
  if (chain.length < 2) return false;
  
  // Patterns like: token.colorPrimary, tokenObj.token.colorPrimary, theme.token.colorPrimary
  return chain.includes('token') || 
         chain[0] === 'token' || 
         (chain.length >= 2 && chain[chain.length - 2] === 'token');
}

function isLikelyTokenName(name: string): boolean {
  const prefixes = ['color', 'font', 'line', 'border', 'spacing', 'control', 'motion', 'size'];
  //const suffixes = ['Radius', 'Height', 'Duration', 'Width', 'Size'];
  const states = ['primary', 'secondary', 'success', 'warning', 'error', 'info'];

  const prefixMatch = prefixes.find(prefix =>
    name.startsWith(prefix) && name.length > prefix.length && /[A-Za-z]/.test(name[prefix.length])
  );

  //const suffixMatch = suffixes.some(suffix => name.endsWith(suffix));
  const stateMatch = states.some(state => name.toLowerCase().includes(state));

  return Boolean(prefixMatch  || stateMatch); // ||suffixMatch
}


function extractValue(node: ts.Expression, sourceFile: ts.SourceFile): string {
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  } else if (ts.isIdentifier(node)) {
    return node.text;
  } else if (ts.isPropertyAccessExpression(node)) {
    return node.getText(sourceFile);
  } else {
    return node.getText(sourceFile);
  }
}

function addTokenToIndex(index: TokenIndex, name: string, data: TokenData) {
  if (!index.has(name)) {
    index.set(name, []);
  }
  index.get(name)!.push(data);
}

// Keep existing JSON and CSS extraction functions
async function extractFromJson(
  filePath: string,
  content: string,
  index: TokenIndex
) {
  try {
    const data = JSON5.parse(content);  // <-- use JSON5
    const collectTokens = (obj: any, path: string[] = []) => {
    if (!obj || typeof obj !== "object") return;
    for (const key in obj) {
      const value = obj[key];
      const fullPath = [...path, key];
      if ((typeof value === "string" || typeof value === "number") && (commonAntdTokens.has(key) || isLikelyTokenName(key))) {
        addTokenToIndex(index, key, {
          uri: filePath,
          value: JSON.stringify(value),
          position: { line: 0, character: 0 },
          source: 'json',
          context: fullPath.join('.')
        });
      } else {
        collectTokens(value, fullPath);
      }
    }};
    collectTokens(data);
  } catch (err) {
    console.warn(`Failed to parse JSON5 in ${filePath}:`, err);
  }
}


async function extractFromCssLike(
  filePath: string,
  content: string,
  index: TokenIndex
) {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const matches = Array.from(lines[i].matchAll(/@([\w-]+)/g));
    for (const match of matches) {
      const token = match[1];
      const pos = match.index ?? 0;
      addTokenToIndex(index, token, {
        uri: filePath,
        value: token,
        position: { line: i, character: pos },
        source: 'css'
      });
    }
  }
}