import {
  Connection,
  createConnection,
  DidChangeWatchedFilesParams,
  Disposable,
  FileOperationOptions,
  Hover,
  HoverParams,
  InitializeParams,
  InitializeResult,
  InlayHint,
  InlayHintParams,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  getWordAtPosition,
  resolveFullTokenValueAtPosition,
  getTokenPropertyAtPosition,
  resolveLocalTokenAtPosition,
  ContextualTokenMatch,
  resolveTokenInContext,
} from "./util";
import { TokenIndex, TokenData } from "./scanner";
import { Position, Location } from "vscode-languageserver-types";
import { scanAndIndexTokens } from "./scanner";
import { fileURLToPath } from "url";
import { createRenameHandler } from "./rename";

export class AntdLs {
  private disposables: Disposable[] = [];
  private tokenIndex: TokenIndex = new Map();
  private rootPath = "";
  private isInitialized = false;

  constructor(
    private connection: Connection,
    private docs: TextDocuments<TextDocument>
  ) {}

  static create(): AntdLs {
    const connection = createConnection(ProposedFeatures.all);
    const docs = new TextDocuments(TextDocument);
    return new AntdLs(connection, docs);
  }

  public async start(): Promise<void> {
    this.connection.onInitialize(this.onInitialize.bind(this));
    this.connection.onInitialized(this.onInitialized.bind(this));
    this.connection.onHover(this.onHover.bind(this));
    this.connection.onDefinition(this.onDefinition.bind(this));
    this.connection.languages.inlayHint.on(this.onInlayHints.bind(this));

    const renameHandler = createRenameHandler(this.docs, this.tokenIndex, this.connection);
    this.connection.onPrepareRename(renameHandler.prepareRename);
    this.connection.onRenameRequest(renameHandler.rename);

    this.connection.onDidChangeWatchedFiles(this.handleFileChange.bind(this));
    this.docs.onDidOpen(this.onDocumentOpen.bind(this));

    this.docs.listen(this.connection);
    this.connection.listen();
  }

  private async onInitialize(params: InitializeParams): Promise<InitializeResult> {
    this.rootPath = params.rootUri ? fileURLToPath(params.rootUri) : "";
    const supportsWatch = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;
    const fileGlob = "**/*.{ts,tsx,js,jsx,json}";
    const fileOps: FileOperationOptions = supportsWatch
      ? {
          didCreate: { filters: [{ pattern: { glob: fileGlob } }] },
          didDelete: { filters: [{ pattern: { glob: fileGlob } }] },
        }
      : {};

    return {
      capabilities: {
        hoverProvider: true,
        definitionProvider: true,
        renameProvider: { prepareProvider: true },
        textDocumentSync: TextDocumentSyncKind.Incremental,
        workspace: { fileOperations: fileOps },
      },
      serverInfo: { name: "Antd Language Server", version: "0.0.1" },
    };
  }

  private async onInitialized(): Promise<void> {
    if (this.rootPath) {
      await this.performTokenIndexing();
      this.isInitialized = true;
    }
  }

  private async onDocumentOpen(): Promise<void> {
    if (!this.isInitialized && this.rootPath) {
      await this.performTokenIndexing();
      this.isInitialized = true;
    }
  }

  private async performTokenIndexing(): Promise<void> {
    if (!this.rootPath) return;
    await scanAndIndexTokens(this.rootPath, this.tokenIndex);
  }

  private async handleFileChange(_: DidChangeWatchedFilesParams): Promise<void> {
    if (this.isInitialized && this.rootPath) {
      await this.performTokenIndexing();
    }
  }

  private onHover({ textDocument, position }: HoverParams): Hover | undefined {
    const doc = this.docs.get(textDocument.uri);
    if (!doc || !this.isInitialized) return;

    let word = getWordAtPosition(doc, position);
    const content = doc.getText();

    // local resolution
    const local = resolveLocalTokenAtPosition(textDocument.uri, content, position, word);
    if (local) {
      return { contents: { kind: 'markdown', value: `**Local**: \`${local}\`` } };
    }

    // full resolution
    const full = resolveFullTokenValueAtPosition(word, content, position);
    if (full?.length) {
      return this.createHoverFromResolvedValues(word, full);
    }

    // property access
    const prop = getTokenPropertyAtPosition(doc, position);
    if (prop && prop !== word) word = prop;

    const defs = this.tokenIndex.get(word) || [];
    if (!defs.length) return;

    const matches = this.prioritizeTokenMatches(defs, doc, position, word, content);
    if (!matches.length) return;

    return this.createPrioritizedHover(word, matches, textDocument.uri, position);
  }

  private prioritizeTokenMatches(
    tokenDefs: TokenData[],
    doc: TextDocument,
    pos: Position,
    name: string,
    content: string
  ): ContextualTokenMatch[] {
    const ctx = resolveTokenInContext(doc, pos, name, this.tokenIndex, content);
    const theme = ctx.filter(m => m.tokenData.source === 'themeConfig');
    if (theme.length) {
      const boosted = theme.map(m => ({ ...m, confidence: Math.min(m.confidence + 20, 100) }));
      return [...boosted, ...ctx.filter(m => m.tokenData.source !== 'themeConfig')]
        .sort((a, b) => b.confidence - a.confidence);
    }
    return ctx.sort((a, b) => b.confidence - a.confidence);
  }

  private createPrioritizedHover(
    word: string,
    matches: ContextualTokenMatch[],
    _uri: string,
    _pos: Position
  ): Hover {
    const primary = matches.find(m => m.tokenData.source === 'themeConfig') || matches[0];
    const icon = this.getSourceIcon(primary.tokenData.source);
    const label = this.getSourceLabel(primary.tokenData.source);

    let md = `**Ant Design Token**: \`${word}\`\n\n` +
             `${icon} **${label}**: \`${primary.tokenData.value}\`\n\n`;

    const usage = this.getTokenUsageInfo(word);
    if (usage) md += `${usage}\n\n`;

    const otherCount = matches.length - 1;
    if (otherCount > 0) md += `**Other definitions available (${otherCount})**`;

    return { contents: { kind: 'markdown', value: md.trim() } };
  }

  private createHoverFromResolvedValues(word: string, vals: string[]): Hover {
    return {
      contents: {
        kind: 'markdown',
        value: `**Ant Design Token**: \`${word}\`\n\n` +
               `Resolved values: ${vals.map(v => `\`${v}\``).join(', ')}`,
      },
    };
  }

  private getSourceIcon(src: TokenData['source']): string {
    return {
      configProvider: '⚙️',
      ts: '📘',
      themeConfig: '🎨',
      json: '📄',
    }[src] || '📋';
  }

  private getSourceLabel(src: TokenData['source']): string {
    return {
      configProvider: 'ConfigProvider',
      ts: 'TypeScript',
      themeConfig: 'ThemeConfig',
      json: 'JSON',
    }[src] || src;
  }

  private getTokenUsageInfo(word: string): string {
    const info: Record<string, string> = {
      // Colors
      colorPrimary: 'Primary brand color used for main actions and highlights',
      colorSuccess: 'Color used to indicate success or positive actions',
      colorWarning: 'Color used for warnings and cautionary visuals',
      colorError: 'Color used to indicate errors or critical issues',
      colorInfo: 'Color used to present informative content',
      colorTextBase: 'Base color for normal body text',
      colorTextSecondary: 'Used for secondary or less important text',
      colorTextDisabled: 'Color for disabled text, often lighter or grayed out',
      colorBgBase: 'Base background color for surfaces like cards and modals',
      colorBorder: 'Default border color for input boxes, cards, etc.',
      colorFillSecondary: 'Used for secondary fills, e.g., hover states',

      // Font
      fontSize: 'Base font size used throughout the UI',
      fontSizeSM: 'Small font size for minor UI elements like captions',
      fontSizeLG: 'Larger font size for headings or key highlights',
      fontFamily: 'Font family used throughout the application',
      lineHeight: 'Default line height for readable text spacing',

      // Spacing
      marginXXS: 'Extra extra small margin spacing',
      marginXS: 'Extra small margin spacing',
      marginSM: 'Small margin spacing',
      marginMD: 'Medium margin spacing',
      marginLG: 'Large margin spacing',
      marginXL: 'Extra large margin spacing',
      paddingXXS: 'Extra extra small padding spacing',
      paddingXS: 'Extra small padding spacing',
      paddingSM: 'Small padding spacing',
      paddingMD: 'Medium padding spacing',
      paddingLG: 'Large padding spacing',
      paddingXL: 'Extra large padding spacing',

      // Border radius
      borderRadius: 'Default border radius for components like buttons and cards',
      borderRadiusSM: 'Small border radius, used for compact components',
      borderRadiusLG: 'Large border radius, often for bigger cards or modals',

      // Shadows
      boxShadow: 'Default box shadow used for popups and elevated elements',
      boxShadowSecondary: 'Secondary shadow, often for subtle depth',

      // Z-index
      zIndexPopup: 'Z-index for popup components like modals or tooltips',

      // Heights and Sizes
      controlHeight: 'Default height of form controls like input and select',
      controlHeightSM: 'Small size variant for compact UI',
      controlHeightLG: 'Large size variant for more prominent UI',
      controlPaddingHorizontal: 'Horizontal padding inside inputs, buttons, etc.',

      // Others
      motionDurationSlow: 'Used for slower animations and transitions',
      motionDurationFast: 'Used for quick transitions like button presses',
      opacityLoading: 'Default opacity for loading overlays and spinners',
    };

    return info[word] ? `💡 Usage: ${info[word]}` : '';
  }


  private onDefinition({ textDocument, position }: { textDocument: { uri: string }; position: Position }): Location[] {
    if (!this.isInitialized) return [];
    const doc = this.docs.get(textDocument.uri);
    if (!doc) return [];

    const name = getTokenPropertyAtPosition(doc, position) || getWordAtPosition(doc, position);
    if (!name) return [];

    const defs = this.tokenIndex.get(name) || [];
    const workspace = defs.filter(d => !d.uri.includes('node_modules'));
    const themeDefs = workspace.filter(d => d.source === 'themeConfig');
    const configDefs = workspace.filter(d => d.source === 'configProvider');
    const chosen = themeDefs.length ? themeDefs : configDefs.length ? configDefs : workspace;

    return chosen.sort((_a, _b) => 0) // could sort
      .map(def => ({ uri: this.toFileUri(def.uri), range: { start: def.position, end: { line: def.position.line, character: def.position.character + name.length } } }));
  }

  private toFileUri(pathStr: string): string {
    let uri = pathStr;
    if (!uri.startsWith('file://')) {
      uri = `file:///${pathStr.replace(/\\/g, '/')}`;
    }
    return uri;
  }

  private async onInlayHints(_: InlayHintParams): Promise<InlayHint[]> {
    return [];
  }
}
