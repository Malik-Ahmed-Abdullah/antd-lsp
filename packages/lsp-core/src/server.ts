import {
  type Connection,
  createConnection,
  type DidChangeWatchedFilesParams,
  type Disposable,
  FileChangeType,
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
import { getWordAtPosition, resolveFullTokenValueAtPosition } from "./util"
import { TokenIndex, TokenData } from "./scanner"
import { Position, Location } from "vscode-languageserver-types"
import { scanAndIndexTokens } from './scanner'
import { fileURLToPath } from 'url'; 

export class AntdLs {
  private readonly disposables: Array<Disposable> = [];
  private tokenIndex: TokenIndex = new Map();

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
    this.connection.onHover(this.onHover.bind(this))
    this.connection.onDefinition(this.onDefinition.bind(this));
    this.connection.languages.inlayHint.on(this.onInlayHints.bind(this))

    this.connection.onDidChangeWatchedFiles(this.handleFileChange.bind(this))

    this.connection.onShutdown(async () => {
      console.debug("Antd Language Server shutting down...")
    })

    this.docs.listen(this.connection)
    this.connection.listen()
  }

  // async dispose(): Promise<void> {
  //   for (const disposable of this.disposables) {
  //     try {
  //       disposable.dispose()
  //     } catch (err) {
  //       console.error("Error disposing:", err)
  //     }
  //   }
  // }

  private async onInitialize(params: InitializeParams): Promise<InitializeResult> {
  console.debug("Antd Language Server initializing...")

  const capabilities = params.capabilities;
  const supportsWatchFileChanges =
    capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;

  const fileWatchGlob = "**/*.{ts,json}";
  let fileOperations: FileOperationOptions = {};
  if (supportsWatchFileChanges) {
    fileOperations = {
      didCreate: { filters: [{ pattern: { glob: fileWatchGlob } }] },
      didDelete: { filters: [{ pattern: { glob: fileWatchGlob } }] },
    };
  }

  const rootUri = params.rootUri ?? "";
  const rootPath = fileURLToPath(rootUri); // <- needed

  await scanAndIndexTokens(rootPath, this.tokenIndex); // <- missing

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

  private handleFileChange(params: DidChangeWatchedFilesParams): void {
    for (const event of params.changes) {
      switch (event.type) {
        case FileChangeType.Created: {
          break
        }
        case FileChangeType.Changed: {
          break
        }
        case FileChangeType.Deleted: {
          break
        }
      }
    }
  }

  private onHover({ textDocument, position }: HoverParams): Hover | undefined {
    const doc = this.docs.get(textDocument.uri);
    if (!doc) return;

    const word = getWordAtPosition(doc, position);
    const fileContent = doc.getText();

    this.connection.console.log(`[Hover] Word: ${word}`);

    const resolvedValue = resolveFullTokenValueAtPosition(
      word,
      fileContent,
      position
    );

    if (resolvedValue) {
      this.connection.console.log(
        `[Hover] Resolved Value (local): ${resolvedValue}`
      );
      return {
        contents: {
          kind: "markdown",
          value: `**AntD Token**: \`${word}\`\n\n📄 From local variable: \`${resolvedValue}\``,
        },
      };
    }

    const token = this.tokenIndex.get(word);
    this.connection.console.log(
      `[Hover] Token Index Value: ${JSON.stringify(token)}`
    );

    if (token && token.value) {
      return {
        contents: {
          kind: "markdown",
          value: `**AntD Token**: \`${word}\`\n\n🎨 Value: \`${token.value}\``,
        },
      };
    }

    return undefined;
  }

  private onDefinition({
    textDocument,
    position,
  }: {
    textDocument: { uri: string };
    position: Position;
  }): Location[] {
    const doc = this.docs.get(textDocument.uri);
    if (!doc) return [];

    const word = getWordAtPosition(doc, position);
    const token = this.tokenIndex.get(word);
    if (!token) return [];

    return [
      {
        uri: token.uri,
        range: {
          start: token.position,
          end: {
            line: token.position.line,
            character: token.position.character + word.length,
          },
        },
      },
    ];
  }

  private async onInlayHints(params: InlayHintParams): Promise<InlayHint[]> {
    return []
  }
}
