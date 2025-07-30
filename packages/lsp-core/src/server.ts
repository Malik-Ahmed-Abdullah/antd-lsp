import {
  type Connection,
  createConnection,
  type DidChangeWatchedFilesParams,
  type Disposable,
  type FileOperationOptions,
  type Hover,
  type HoverParams,
  type InitializeParams,
  type InitializeResult,
  type InlayHint,
  type InlayHintParams,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"
import { getWordAtPosition, resolveFullTokenValueAtPosition, getTokenPropertyAtPosition , findExactTokenDefinitionAtPosition} from "./util"
import { TokenIndex, TokenData } from "./scanner"
import { Position, Location } from "vscode-languageserver-types"
import { scanAndIndexTokens } from './scanner'
import { fileURLToPath } from 'url'; 

export class AntdLs {
  private readonly disposables: Array<Disposable> = [];
  private tokenIndex: TokenIndex = new Map();
  private rootPath: string = '';
  private isInitialized: boolean = false;

  constructor(
    private readonly connection: Connection,
    private readonly docs: TextDocuments<TextDocument>,
  ) {
    console.debug("AntdLs instance created.")
  }

  static create(): AntdLs {
    const connection = createConnection(ProposedFeatures.all)
    const docs = new TextDocuments(TextDocument)

    return new AntdLs(connection, docs)
  }

  async start(): Promise<void> {
    this.connection.onInitialize(this.onInitialize.bind(this))
    this.connection.onInitialized(this.onInitialized.bind(this)) // Add this handler
    this.connection.onHover(this.onHover.bind(this))
    this.connection.onDefinition(this.onDefinition.bind(this));
    this.connection.languages.inlayHint.on(this.onInlayHints.bind(this))

    this.connection.onDidChangeWatchedFiles(this.handleFileChange.bind(this))

    // Also trigger indexing when documents are opened
    this.docs.onDidOpen(this.onDocumentOpen.bind(this))

    this.connection.onShutdown(async () => {
      console.debug("Antd Language Server shutting down...")
    })

    this.docs.listen(this.connection)
    this.connection.listen()
  }

  private async onInitialize(params: InitializeParams): Promise<InitializeResult> {
    console.debug("Antd Language Server initializing...")
    
    // Store the root path but don't scan yet
    this.rootPath = params.rootUri ? fileURLToPath(params.rootUri) : "";
    
    const capabilities = params.capabilities;
    const supportsWatchFileChanges =
      capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;

    const fileWatchGlob = "**/*.{ts,tsx,js,jsx,json}";
    let fileOperations: FileOperationOptions = {};
    if (supportsWatchFileChanges) {
      fileOperations = {
        didCreate: { filters: [{ pattern: { glob: fileWatchGlob } }] },
        didDelete: { filters: [{ pattern: { glob: fileWatchGlob } }] },
      };
    }

    return {
      capabilities: {
        hoverProvider: true,
        inlayHintProvider: false,
        definitionProvider: true,
        textDocumentSync: TextDocumentSyncKind.Incremental,
        workspace: { fileOperations },
      },
      serverInfo: {
        name: "Antd Language Server",
        version: "0.0.1",
      },
    };
  }

  // New method: called after initialization is complete
  private async onInitialized(): Promise<void> {
    console.debug("Antd Language Server initialized, starting token indexing...")
    
    if (this.rootPath) {
      try {
        await this.performTokenIndexing();
        this.isInitialized = true;
        this.connection.console.log(`Initial token indexing completed. Found ${this.tokenIndex.size} unique tokens.`);
      } catch (error) {
        this.connection.console.error(`Failed to perform initial token indexing: ${error}`);
      }
    }
  }

  // New method: called when a document is opened
  private async onDocumentOpen(): Promise<void> {
    // If we haven't indexed yet (fallback), do it now
    if (!this.isInitialized && this.rootPath) {
      console.debug("Document opened, triggering token indexing as fallback...")
      try {
        await this.performTokenIndexing();
        this.isInitialized = true;
        this.connection.console.log(`Token indexing completed on document open. Found ${this.tokenIndex.size} unique tokens.`);
      } catch (error) {
        this.connection.console.error(`Failed to perform token indexing on document open: ${error}`);
      }
    }
  }

  private async performTokenIndexing(): Promise<void> {
    if (!this.rootPath) {
      console.warn("No root path available for token indexing");
      return;
    }

    console.debug(`Starting token indexing for path: ${this.rootPath}`);
    
    try {
      await scanAndIndexTokens(this.rootPath, this.tokenIndex);
      console.debug(`Token indexing completed. Index size: ${this.tokenIndex.size}`);
      
      // Log some debug info about what was found
      if (this.tokenIndex.size > 0) {
        const sampleTokens = Array.from(this.tokenIndex.keys()).slice(0, 10);
        this.connection.console.log(`Sample tokens found: ${sampleTokens.join(', ')}`);
        
        // Log distribution by source type
        const sourceDistribution: Record<string, number> = {};
        for (const tokenDefs of Array.from(this.tokenIndex.values())) {
          for (const def of tokenDefs) {
            sourceDistribution[def.source] = (sourceDistribution[def.source] || 0) + 1;
          }
        }
        this.connection.console.log(`Token sources: ${JSON.stringify(sourceDistribution)}`);
      } else {
        this.connection.console.log("No tokens found during indexing");
      }
    } catch (error) {
      this.connection.console.error(`Token indexing failed: ${error}`);
      throw error;
    }
  }

  private async handleFileChange(_params: DidChangeWatchedFilesParams): Promise<void> {
    if (!this.isInitialized) {
      console.debug("File change detected but not initialized yet, skipping re-index");
      return;
    }

    // Re-scan the entire project when files change
    if (this.rootPath) {
      try {
        await this.performTokenIndexing();
        this.connection.console.log(`Re-indexed tokens after file changes. Found ${this.tokenIndex.size} unique tokens.`);
      } catch (error) {
        this.connection.console.error(`Failed to re-index tokens: ${error}`);
      }
    }
  }

  private onHover({ textDocument, position }: HoverParams): Hover | undefined {
    const doc = this.docs.get(textDocument.uri);
    if (!doc) return;

    // Ensure we're initialized before processing hover
    if (!this.isInitialized) {
      this.connection.console.log("Hover request received but server not fully initialized yet");
      // Trigger indexing as emergency fallback
      if (this.rootPath) {
        this.performTokenIndexing().then(() => {
          this.isInitialized = true;
        }).catch(error => {
          this.connection.console.error(`Emergency token indexing failed: ${error}`);
        });
      }
      return undefined;
    }

    const word = getWordAtPosition(doc, position);
    const fileContent = doc.getText();

    this.connection.console.log(`[Hover] Word: ${word} at ${position.line}:${position.character}, Index size: ${this.tokenIndex.size}`);

    // First, try to resolve local token values (like theme.token.colorPrimary)
    const resolvedValues = resolveFullTokenValueAtPosition(
      word,
      fileContent,
      position
    );

    if (resolvedValues && resolvedValues.length > 0) {
      this.connection.console.log(`[Hover] Resolved local values: ${JSON.stringify(resolvedValues)}`);
      return this.createHoverFromResolvedValues(word, resolvedValues);
    }

    // Check if we're hovering over a token property access
    const tokenProperty = getTokenPropertyAtPosition(doc, position);
    if (tokenProperty) {
      this.connection.console.log(`[Hover] Token property: ${tokenProperty}`);
      const tokenDefs = this.tokenIndex.get(tokenProperty);
      if (tokenDefs && tokenDefs.length > 0) {
          const exactMatch = findExactTokenDefinitionAtPosition(fileContent, position, word, tokenDefs);
          if (exactMatch) {
            return this.createHoverFromTokenDefs(word, [exactMatch], textDocument.uri, position);
          }
      }
    }

    // Check the token index for the word
    const tokenDefs = this.tokenIndex.get(word);
    this.connection.console.log(`[Hover] Token Index Definitions for '${word}': ${tokenDefs ? tokenDefs.length : 0} found`);

    if (tokenDefs && tokenDefs.length > 0) {
      const exactMatch = findExactTokenDefinitionAtPosition(fileContent, position, word, tokenDefs);
      if (exactMatch) {
        return this.createHoverFromTokenDefs(word, [exactMatch], textDocument.uri, position);
      }
    }


    return undefined;
  }

  private createHoverFromResolvedValues(word: string, values: string[]): Hover {
    const valueList = values.map(v => `\`${v}\``).join(', ');
    return {
      contents: {
        kind: "markdown",
        value: `**Ant Design Token**: \`${word}\`\n\n📄 **Local Values**: ${valueList}\n\n*Resolved from local variable assignments*`,
      },
    };
  }

  private createHoverFromTokenDefs(word: string, tokenDefs: TokenData[], currentUri?: string, position?: Position): Hover {
  let content = `**Ant Design Token**: \`${word}\`\n\n`;

  // Prefer tokens from same file
  const sortedDefs = [...tokenDefs].sort((a, b) => {
    const aScore = (a.uri === currentUri ? 1 : 0) + (a.position.line === position?.line ? 1 : 0);
    const bScore = (b.uri === currentUri ? 1 : 0) + (b.position.line === position?.line ? 1 : 0);
    return bScore - aScore;
  });

  // Group by source
  const bySource = sortedDefs.reduce((acc, def) => {
    if (!acc[def.source]) acc[def.source] = [];
    acc[def.source].push(def);
    return acc;
  }, {} as Record<string, TokenData[]>);

  for (const [source, defs] of Object.entries(bySource)) {
    const icon = this.getSourceIcon(source as TokenData['source']);
    content += `${icon} **${this.getSourceLabel(source as TokenData['source'])}**:\n`;

    for (const def of defs) {
      const fileName = def.uri.split('/').pop() || def.uri;
      content += `  - \`${def.value}\` *(${fileName}${def.context ? `, ${def.context}` : ''})*\n`;
    }
    content += '\n';
  }

  if (this.isCommonAntdToken(word)) {
    content += this.getTokenUsageInfo(word);
  }

  return {
    contents: {
      kind: "markdown",
      value: content.trim(),
    },
  };
}


  private getSourceIcon(source: TokenData['source']): string {
    const icons = {
      'configProvider': '⚙️',
      'useToken': '🪝',
      'getToken': '🔍',
      'themeConfig': '🎨',
      'json': '📄',
      'css': '🎭'
    };
    return icons[source] || '📋';
  }

  private getSourceLabel(source: TokenData['source']): string {
    const labels = {
      'configProvider': 'ConfigProvider',
      'useToken': 'useToken() Hook',
      'getToken': 'getToken() Hook',
      'themeConfig': 'ThemeConfig',
      'json': 'JSON Config',
      'css': 'CSS/LESS/SCSS'
    };
    return labels[source] || source;
  }

  private isCommonAntdToken(word: string): boolean {
    const commonTokens = [
      'colorPrimary', 'colorSuccess', 'colorWarning', 'colorError', 'colorInfo',
      'colorTextBase', 'colorBgBase', 'colorText', 'colorTextSecondary',
      'borderRadius', 'borderRadiusLG', 'borderRadiusSM', 'borderRadiusXS',
      'fontSize', 'fontSizeLG', 'fontSizeSM', 'fontSizeXL'
    ];
    return commonTokens.includes(word);
  }

  private getTokenUsageInfo(word: string): string {
    const tokenInfo: Record<string, string> = {
      'colorPrimary': 'Primary brand color used for main actions and highlights',
      'colorSuccess': 'Success state color for positive feedback',
      'colorWarning': 'Warning state color for caution states',
      'colorError': 'Error state color for negative feedback',
      'colorInfo': 'Info state color for informational content',
      'borderRadius': 'Base border radius for rounded corners',
      'borderRadiusLG': 'Large border radius for prominent elements',
      'borderRadiusSM': 'Small border radius for subtle rounding',
      'fontSize': 'Base font size for body text',
      'fontSizeLG': 'Large font size for headings',
      'fontSizeSM': 'Small font size for secondary text'
    };

    const info = tokenInfo[word];
    if (info) {
      return `\n💡 **Usage**: ${info}`;
    }
    return '';
  }

  private onDefinition({
    textDocument,
    position,
  }: {
    textDocument: { uri: string };
    position: Position;
  }): Location[] {
    const doc = this.docs.get(textDocument.uri);
    if (!doc || !this.isInitialized) return [];

    const word = getWordAtPosition(doc, position);
    
    // Check if we're hovering over a token property access
    const tokenProperty = getTokenPropertyAtPosition(doc, position);
    const searchTerm = tokenProperty || word;
    
    const tokenDefs = this.tokenIndex.get(searchTerm);
    if (!tokenDefs || tokenDefs.length === 0) return [];

    return tokenDefs.map(token => ({
      uri: token.uri,
      range: {
        start: token.position,
        end: {
          line: token.position.line,
          character: token.position.character + searchTerm.length,
        },
      },
    }));
  }

  private async onInlayHints(_params: InlayHintParams): Promise<InlayHint[]> {
    // TODO: Could add inlay hints showing token values inline
    return []
  }
}