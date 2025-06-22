import {
  Connection,
  createConnection,
  type Disposable,
  type Hover,
  type HoverParams,
  type InitializeParams,
  type InitializeResult,
  ProposedFeatures,
  TextDocuments,
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"
import { scanAndIndexTokens, type TokenIndex } from "./scanner.js"
import { attachWatcher } from "./watcher.js"

const configureTokenIndex = async (
  rootUri: string,
  tokenIndex: TokenIndex,
  onDestroy: Array<() => Promise<void>>,
) => {
  await scanAndIndexTokens(rootUri, tokenIndex)
  const unsubscribe = await attachWatcher(rootUri, tokenIndex)
  onDestroy.push(unsubscribe)
}

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
    const initDispose = this.connection.onInitialize(async (params) =>
      this.onInitialize(params),
    )
    this.disposables.push(initDispose)

    const hoverDispose = this.connection.onHover(this.onHover.bind(this))
    this.disposables.push(hoverDispose)

    const shutdownDispose = this.connection.onShutdown(() => {
      console.debug("Antd Language Server shutting down...")
    })
    this.disposables.push(shutdownDispose)

    this.docs.listen(this.connection)
    this.connection.listen()
  }

  async dispose(): Promise<void> {
    for (const disposable of this.disposables) {
      try {
        disposable.dispose()
      } catch (err) {
        console.error("Error disposing:", err)
      }
    }
  }

  private async onInitialize(
    params: InitializeParams,
  ): Promise<InitializeResult> {
    console.debug("Antd Language Server initializing...")
    // if (params.workspaceFolders) {
    //   for (const workspace of params.workspaceFolders) {
    //     await configureTokenIndex(workspace.uri, tokenIndex, onDestroy)
    //   }
    // } else if (params.rootUri) {
    //   await configureTokenIndex(params.rootUri, tokenIndex, onDestroy)
    // } else if (params.rootPath) {
    //   await configureTokenIndex(params.rootPath, tokenIndex, onDestroy)
    // }

    return {
      capabilities: { hoverProvider: true, inlayHintProvider: true },
      serverInfo: {
        name: "Antd Language Server",
        version: "0.0.1",
      },
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
}
