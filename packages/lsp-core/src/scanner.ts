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
  source: 'configProvider' | 'themeConfig' | 'json' | 'ts';
  context?: string; // Additional context like component name or variable name
};

export type TokenIndex = Map<TokenName, TokenData[]>; // Changed to array to handle multiple definitions

const supportedExtensions = /\.(ts|tsx|js|jsx|json)$/; 
const ignoredDirs = ["node_modules", "dist", "build", ".git", ".next", "out", "coverage", "public", "tmp", "temp", "logs", "cache", "css", "scss", "less", "styles", "assets", "static", "vendor", "bower_components"];

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
          source: "ts",
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

function isLikelyTokenName(name: string): boolean {
  const prefixes = ['color', 'font', 'line', 'border', 'spacing', 'control', 'motion', 'size'];
  const states = ['primary', 'secondary', 'success', 'warning', 'error', 'info'];

  const prefixMatch = prefixes.some(prefix => name.startsWith(prefix));
  const stateMatch = states.some(state => name.toLowerCase().includes(state));
  const camelCasePattern = /^[a-z]+(?:[A-Z][a-z]*)+$/;

  return (prefixMatch || stateMatch || camelCasePattern.test(name));
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
