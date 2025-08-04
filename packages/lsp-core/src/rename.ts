import { 
  TextDocuments, 
  RenameParams, 
  WorkspaceEdit, 
  TextEdit, 
  PrepareRenameParams,
  Range,
  ResponseError,
  ErrorCodes,
  Position,
  Connection
} from "vscode-languageserver";
import { TokenIndex, TokenData } from "./scanner";
import { getWordAtPosition, getTokenPropertyAtPosition } from "./util";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from 'vscode-uri';

export function createRenameHandler(
  documents: TextDocuments<TextDocument>,
  tokenIndex: TokenIndex,
  connection: Connection
) {
  return {
    prepareRename: async function(params: PrepareRenameParams): Promise<Range | { range: Range; placeholder: string } | null> {
      const doc = documents.get(params.textDocument.uri);
      if (!doc) return null;

      const word = getWordAtPosition(doc, params.position);
      if (!word) return null;

      // Check if it's a token property access
      const tokenProperty = getTokenPropertyAtPosition(doc, params.position);
      const targetToken = tokenProperty || word;

      connection.console.log(`[Rename] PrepareRename for: ${targetToken} (original word: ${word})`);

      // Check if this token exists in our index
      if (!tokenIndex.has(targetToken)) {
        connection.console.log(`[Rename] Token '${targetToken}' not found in index`);
        throw new ResponseError(
          ErrorCodes.InvalidRequest,
          `Cannot rename '${targetToken}' - not an Ant Design token`
        );
      }

      // Get the exact range using a simple approach
      const range = getExactTokenRange(doc, params.position, targetToken);
      if (!range) {
        throw new ResponseError(
          ErrorCodes.InvalidRequest,
          `Cannot determine exact range for token '${targetToken}'`
        );
      }

      return {
        range,
        placeholder: targetToken
      };
    },

    rename: async function(params: RenameParams): Promise<WorkspaceEdit | null> {
      try {
        const result = await handleRename(params, documents, tokenIndex, connection);
        connection.console.log(`[Rename] Rename result: ${result ? 'success' : 'no changes'}`);
        return result;
      } catch (error) {
        connection.console.log(`[Rename] Error in rename handler: ${error}`);
        throw new ResponseError(
          ErrorCodes.InternalError,
          `Rename failed: ${error}`
        );
      }
    }
  };
}

function getExactTokenRange(doc: TextDocument, position: Position, tokenName: string): Range | null {
  const line = doc.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 }
  });

  // Remove the newline if present
  const cleanLine = line.replace(/\n$/, '');

  // First, try to find token property access patterns
  const tokenAccessRegex = /(\w+\.)*token\.(\w+)/g;
  let match: RegExpExecArray | null;
  
  while ((match = tokenAccessRegex.exec(cleanLine))) {
    const fullMatch = match[0];
    const property = match[2];
    const matchStart = match.index;
    
    if (property === tokenName) {
      const propertyStart = matchStart + fullMatch.lastIndexOf(property);
      const propertyEnd = propertyStart + property.length;
      
      if (position.character >= propertyStart && position.character <= propertyEnd) {
        return {
          start: { line: position.line, character: propertyStart },
          end: { line: position.line, character: propertyEnd }
        };
      }
    }
  }

  // Fallback: find regular word boundaries
  const wordRegex = /\w+/g;
  while ((match = wordRegex.exec(cleanLine))) {
    if (match[0] === tokenName) {
      const start = match.index;
      const end = start + match[0].length;
      
      if (position.character >= start && position.character <= end) {
        return {
          start: { line: position.line, character: start },
          end: { line: position.line, character: end }
        };
      }
    }
  }

  return null;
}

async function handleRename(
  params: RenameParams,
  documents: TextDocuments<TextDocument>,
  tokenIndex: TokenIndex,
  connection: Connection
): Promise<WorkspaceEdit | null> {
  const { textDocument, position, newName } = params;
  const doc = documents.get(textDocument.uri);
  if (!doc) {
    connection.console.log(`[Rename] Document not found for ${textDocument.uri}`);
    return null;
  }

  // Validate new name
  if (!newName || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(newName)) {
    throw new ResponseError(
      ErrorCodes.InvalidRequest,
      `Invalid token name '${newName}'. Token names must be valid identifiers.`
    );
  }

  const word = getWordAtPosition(doc, position);
  if (!word) {
    connection.console.log(`[Rename] No word found at position`);
    return null;
  }

  const tokenProperty = getTokenPropertyAtPosition(doc, position);
  const oldTokenName = tokenProperty || word;

  connection.console.log(`[Rename] Renaming '${oldTokenName}' to '${newName}'`);

  const changes: Record<string, TextEdit[]> = {};

  try {
    // Get all token definitions from the index
    const tokenDefinitions = tokenIndex.get(oldTokenName);
    if (!tokenDefinitions || tokenDefinitions.length === 0) {
      connection.console.log(`[Rename] Token '${oldTokenName}' not found in index`);
      throw new ResponseError(
        ErrorCodes.InvalidRequest,
        `Token '${oldTokenName}' not found in index`
      );
    }

    // Only process documents that are currently open/available
    const availableDocuments = documents.all();
    const availableUris = new Set(availableDocuments.map(d => d.uri));

    connection.console.log(`[Rename] Processing ${availableDocuments.length} available documents`);

    // Step 1: Find all usages across available documents
    for (const document of availableDocuments) {
      try {
        const documentEdits = findAllTokenOccurrences(document, oldTokenName, newName, connection);
        
        if (documentEdits.length > 0) {
          // Normalize URI format
          const normalizedUri = normalizeUri(document.uri);
          changes[normalizedUri] = documentEdits;
          connection.console.log(`[Rename] Added ${documentEdits.length} edits for ${normalizedUri}`);
        }
      } catch (error) {
        connection.console.log(`[Rename] Error processing document ${document.uri}: ${error}`);
      }
    }

    // Step 2: Handle token definitions that are in available documents
    for (const tokenDef of tokenDefinitions) {
      try {
        const normalizedDefUri = normalizeUri(tokenDef.uri);
        
        // Only process if the file is available in the document manager
        if (availableUris.has(tokenDef.uri) || availableUris.has(normalizedDefUri)) {
          const defDoc = documents.get(tokenDef.uri) || documents.get(normalizedDefUri);
          if (defDoc) {
            const definitionEdits = handleTokenDefinitionInDocument(defDoc, tokenDef, oldTokenName, newName, connection);
            
            if (definitionEdits.length > 0) {
              const uri = normalizeUri(defDoc.uri);
              if (!changes[uri]) {
                changes[uri] = [];
              }
              
              // Merge edits and remove duplicates
              const mergedEdits = mergeAndDeduplicateEdits([...changes[uri], ...definitionEdits]);
              changes[uri] = mergedEdits;
              connection.console.log(`[Rename] Added ${definitionEdits.length} definition edits for ${uri}`);
            }
          }
        } else {
          connection.console.log(`[Rename] Skipping unavailable file: ${tokenDef.uri}`);
        }
      } catch (error) {
        connection.console.log(`[Rename] Error processing definition in ${tokenDef.uri}: ${error}`);
      }
    }

    const totalChanges = Object.values(changes).reduce((sum, edits) => sum + edits.length, 0);
    connection.console.log(`[Rename] Prepared ${totalChanges} total changes across ${Object.keys(changes).length} files`);

    if (totalChanges === 0) {
      connection.console.log(`[Rename] No changes found, returning null`);
      return null;
    }

    // Sort edits by position (descending) to avoid position shift issues
    for (const uri in changes) {
      changes[uri] = changes[uri].sort((a, b) => {
        if (a.range.start.line !== b.range.start.line) {
          return b.range.start.line - a.range.start.line;
        }
        return b.range.start.character - a.range.start.character;
      });
    }

    return { changes };
  } catch (error) {
    connection.console.log(`[Rename] Error in handleRename: ${error}`);
    throw error;
  }
}

function normalizeUri(uri: string): string {
  try {
    // If it's already a proper URI, return as is
    if (uri.startsWith('file://')) {
      return uri;
    }
    
    // If it's a file path, convert to URI
    return URI.file(uri).toString();
  } catch (error) {
    // Fallback: return original uri
    return uri;
  }
}

function mergeAndDeduplicateEdits(edits: TextEdit[]): TextEdit[] {
  const uniqueEdits = new Map<string, TextEdit>();
  
  for (const edit of edits) {
    const key = `${edit.range.start.line}:${edit.range.start.character}:${edit.range.end.line}:${edit.range.end.character}`;
    if (!uniqueEdits.has(key)) {
      uniqueEdits.set(key, edit);
    }
  }
  
  return Array.from(uniqueEdits.values());
}

function handleTokenDefinitionInDocument(
  doc: TextDocument,
  tokenDef: TokenData,
  oldTokenName: string,
  newName: string,
  connection: Connection
): TextEdit[] {
  const edits: TextEdit[] = [];
  const content = doc.getText();
  const lines = content.split('\n');

  try {
    // Handle different file types based on URI extension
    const uri = doc.uri.toLowerCase();
    
    if (uri.endsWith('.json')) {
      // Handle JSON files
      const jsonEdits = handleJsonTokenDefinition(lines, tokenDef, oldTokenName, newName, connection);
      edits.push(...jsonEdits);
    } else if (uri.endsWith('.ts') || uri.endsWith('.tsx') || uri.endsWith('.js') || uri.endsWith('.jsx')) {
      // Handle TypeScript/JavaScript files
      const tsEdits = handleTsTokenDefinition(lines, tokenDef, oldTokenName, newName, connection);
      edits.push(...tsEdits);
    }
  } catch (error) {
    connection.console.log(`[Rename] Error handling token definition in ${doc.uri}: ${error}`);
  }

  return edits;
}

function handleJsonTokenDefinition(
  lines: string[],
  tokenDef: TokenData,
  oldTokenName: string,
  newName: string,
  connection: Connection
): TextEdit[] {
  const edits: TextEdit[] = [];

  try {
    // Search around the token definition position for better accuracy
    const defLine = tokenDef.position.line;
    const searchStart = Math.max(0, defLine - 2);
    const searchEnd = Math.min(lines.length, defLine + 3);

    for (let lineIndex = searchStart; lineIndex < searchEnd; lineIndex++) {
      const line = lines[lineIndex];
      
      // Look for property key patterns: "tokenName": or tokenName:
      const quotedKeyRegex = new RegExp(`"${escapeRegExp(oldTokenName)}"(?=\\s*:)`, 'g');
      const unquotedKeyRegex = new RegExp(`\\b${escapeRegExp(oldTokenName)}(?=\\s*:)`, 'g');
      
      let match = quotedKeyRegex.exec(line);
      if (match) {
        const start = match.index + 1; // Skip opening quote
        const end = start + oldTokenName.length;
        edits.push({
          newText: newName,
          range: {
            start: { line: lineIndex, character: start },
            end: { line: lineIndex, character: end }
          }
        });
        connection.console.log(`[Rename] Found JSON quoted key at line ${lineIndex}`);
      }

      unquotedKeyRegex.lastIndex = 0;
      match = unquotedKeyRegex.exec(line);
      if (match) {
        const start = match.index;
        const end = start + oldTokenName.length;
        edits.push({
          newText: newName,
          range: {
            start: { line: lineIndex, character: start },
            end: { line: lineIndex, character: end }
          }
        });
        connection.console.log(`[Rename] Found JSON unquoted key at line ${lineIndex}`);
      }
    }
  } catch (error) {
    connection.console.log(`[Rename] Error processing JSON definition: ${error}`);
  }

  return edits;
}

function handleTsTokenDefinition(
  lines: string[],
  tokenDef: TokenData,
  oldTokenName: string,
  newName: string,
  connection: Connection
): TextEdit[] {
  const edits: TextEdit[] = [];

  try {
    // Search around the token definition position
    const defLine = tokenDef.position.line;
    const searchStart = Math.max(0, defLine - 1);
    const searchEnd = Math.min(lines.length, defLine + 2);

    for (let lineIndex = searchStart; lineIndex < searchEnd; lineIndex++) {
      const line = lines[lineIndex];
      
      // Pattern 1: Object property definition (tokenName: value)
      const objPropRegex = new RegExp(`\\b${escapeRegExp(oldTokenName)}(?=\\s*:)`, 'g');
      let match = objPropRegex.exec(line);
      if (match) {
        edits.push({
          newText: newName,
          range: {
            start: { line: lineIndex, character: match.index },
            end: { line: lineIndex, character: match.index + oldTokenName.length }
          }
        });
        connection.console.log(`[Rename] Found TS object property definition at line ${lineIndex}`);
      }

      // Pattern 2: Quoted property key ("tokenName": value)
      const quotedPropRegex = new RegExp(`"${escapeRegExp(oldTokenName)}"(?=\\s*:)`, 'g');
      match = quotedPropRegex.exec(line);
      if (match) {
        const start = match.index + 1; // Skip opening quote
        const end = start + oldTokenName.length;
        edits.push({
          newText: newName,
          range: {
            start: { line: lineIndex, character: start },
            end: { line: lineIndex, character: end }
          }
        });
        connection.console.log(`[Rename] Found TS quoted property definition at line ${lineIndex}`);
      }
    }
  } catch (error) {
    connection.console.log(`[Rename] Error processing TS definition: ${error}`);
  }

  return edits;
}

function findAllTokenOccurrences(
  document: TextDocument,
  tokenName: string,
  newName: string,
  connection: Connection
): TextEdit[] {
  try {
    const content = document.getText();
    const lines = content.split('\n');
    const edits: TextEdit[] = [];

    connection.console.log(`[Rename] Searching for '${tokenName}' usages in ${document.uri}`);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      
      try {
        // Pattern 1: Property access (token.tokenName, theme.token.tokenName)
        findPropertyAccessUsages(line, lineIndex, tokenName, newName, edits);
        
        // Pattern 2: Template literal usage (`${token.tokenName}`)
        findTemplateLiteralUsages(line, lineIndex, tokenName, newName, edits);
        
        // Pattern 3: Object property assignments (tokenName: value) - only in non-definition contexts
        findObjectPropertyUsages(line, lineIndex, tokenName, newName, edits);
        
      } catch (error) {
        connection.console.log(`[Rename] Error processing line ${lineIndex} in ${document.uri}: ${error}`);
      }
    }

    connection.console.log(`[Rename] Found ${edits.length} usage occurrences in ${document.uri}`);
    return edits;
  } catch (error) {
    connection.console.log(`[Rename] Error in findAllTokenOccurrences for ${document.uri}: ${error}`);
    return [];
  }
}

function findObjectPropertyUsages(
  line: string,
  lineIndex: number,
  tokenName: string,
  newName: string,
  edits: TextEdit[]
): void {
  // Match: tokenName followed by colon, but only in usage contexts (not in theme definitions)
  // Skip lines that look like theme config definitions
  if (line.includes('theme:') || line.includes('ThemeConfig') || line.includes('token:')) {
    return;
  }

  const regex = new RegExp(`\\b${escapeRegExp(tokenName)}(?=\\s*:)`, 'g');
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line)) !== null) {
    edits.push({
      newText: newName,
      range: {
        start: { line: lineIndex, character: match.index },
        end: { line: lineIndex, character: match.index + tokenName.length }
      }
    });
  }
}

function findPropertyAccessUsages(
  line: string,
  lineIndex: number,
  tokenName: string,
  newName: string,
  edits: TextEdit[]
): void {
  // Match: .tokenName or token.tokenName patterns
  const patterns = [
    new RegExp(`\\btoken\\.${escapeRegExp(tokenName)}\\b`, 'g'),
    new RegExp(`\\.token\\.${escapeRegExp(tokenName)}\\b`, 'g')
  ];

  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    regex.lastIndex = 0;

    while ((match = regex.exec(line)) !== null) {
      const tokenStart = match.index + match[0].lastIndexOf(tokenName);
      edits.push({
        newText: newName,
        range: {
          start: { line: lineIndex, character: tokenStart },
          end: { line: lineIndex, character: tokenStart + tokenName.length }
        }
      });
    }
  }
}

function findTemplateLiteralUsages(
  line: string,
  lineIndex: number,
  tokenName: string,
  newName: string,
  edits: TextEdit[]
): void {
  // Match template literals with token access: ${token.tokenName}
  const templateRegex = new RegExp(`\\$\\{[^}]*\\btoken\\.${escapeRegExp(tokenName)}\\b[^}]*\\}`, 'g');
  let match: RegExpExecArray | null;

  while ((match = templateRegex.exec(line)) !== null) {
    const tokenStart = match.index + match[0].lastIndexOf(tokenName);
    edits.push({
      newText: newName,
      range: {
        start: { line: lineIndex, character: tokenStart },
        end: { line: lineIndex, character: tokenStart + tokenName.length }
      }
    });
  }
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}