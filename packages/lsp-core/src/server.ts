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

export class AntdLs {
  private readonly disposables: Array<Disposable> = []

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

  private async onInitialize(
    params: InitializeParams,
  ): Promise<InitializeResult> {
    console.debug("Antd Language Server initializing...")

    const capabilities = params.capabilities
    const supportsWatchFileChanges =
      capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration

    // Get from settings or initialize params
    const fileWatchGlob = "**/*.{ts,json}"
    let fileOperations: FileOperationOptions = {}
    if (supportsWatchFileChanges) {
      fileOperations = {
        didCreate: { filters: [{ pattern: { glob: fileWatchGlob } }] },
        didDelete: { filters: [{ pattern: { glob: fileWatchGlob } }] },
      }
    }
    return {
      capabilities: {
        hoverProvider: true,
        inlayHintProvider: false, // add later on
        textDocumentSync: TextDocumentSyncKind.Incremental,
        workspace: { fileOperations },
      },
      serverInfo: {
        name: "Antd Language Server",
        version: "0.0.1",
      },
    }
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

  private onHover({ textDocument, position }: HoverParams): Hover {
    console.debug(
      "Received hover request for document:",
      textDocument.uri,
      "at position:",
      position,
    )

    return {
      contents: { kind: "markdown", value: "## Token Value\nred" },
    }
  }

  private async onInlayHints(params: InlayHintParams): Promise<InlayHint[]> {
    return []
  }
}
