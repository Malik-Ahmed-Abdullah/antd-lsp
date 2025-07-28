import ts from "typescript";
import fs from "fs/promises";
import path from "path";
import type { Position } from "vscode-languageserver";

export type TokenName = string;

export type TokenData = {
  uri: string;
  value: string;
  position: Position;
};

export type TokenIndex = Map<TokenName, TokenData>;

const supportedExtensions = /\.(ts|tsx|js|jsx|json|css|less|scss)$/;
const ignoredDirs = ["node_modules", "dist", "build", ".git", ".next", "out"];

export async function scanAndIndexTokens(
  rootUri: string,
  tokenIndex: TokenIndex
): Promise<void> {
  const files = await findAllFiles(rootUri);
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf-8");
    if (/\.(ts|tsx|js|jsx)$/.test(filePath)) {
      await extractFromTs(filePath, content, tokenIndex);
    } else if (filePath.endsWith(".json")) {
      await extractFromJson(filePath, content, tokenIndex);
    } else if (/\.(css|less|scss)$/.test(filePath)) {
      await extractFromCssLike(filePath, content, tokenIndex);
    }
  }
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

async function extractFromTs(
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

              let value = "";

              if (
                ts.isStringLiteral(prop.initializer) ||
                ts.isNumericLiteral(prop.initializer)
              ) {
                value = prop.initializer.text;
              } else if (ts.isIdentifier(prop.initializer)) {
                value = prop.initializer.text;
              } else {
                value = prop.initializer.getText(sourceFile);
              }

              index.set(name, {
                uri: filePath,
                value,
                position: pos,
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

async function extractFromJson(
  filePath: string,
  content: string,
  index: TokenIndex
) {
  try {
    const data = JSON.parse(content);
    const collectTokens = (obj: any) => {
      if (!obj || typeof obj !== "object") return;
      for (const key in obj) {
        if (key === "token" && typeof obj[key] === "object") {
          for (const tokenName in obj[key]) {
            index.set(tokenName, {
              uri: filePath,
              value: JSON.stringify(obj[key][tokenName]) ?? tokenName,
              position: { line: 0, character: 0 },
            });
          }
        } else {
          collectTokens(obj[key]);
        }
      }
    };
    collectTokens(data);
  } catch {
    // skip invalid JSON
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
      index.set(token, {
        uri: filePath,
        value: token,
        position: { line: i, character: pos },
      });
    }
  }
}