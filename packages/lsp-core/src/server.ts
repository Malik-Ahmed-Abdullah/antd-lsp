import watcher from "@parcel/watcher"
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"
import { scanAndIndexTokens, type TokenIndex } from "./scanner"

const attachWatcher = async (rootUri: string, tokenIndex: TokenIndex) => {
  const { unsubscribe } = await watcher.subscribe(rootUri, (err, events) => {
    for (const event of events) {
      switch (event.type) {
        case "create": {
          break
        }
        case "update": {
          break
        }
        case "delete": {
          break
        }
        default: {
          throw new Error(`Unknown event type: ${event.type}`)
        }
      }
    }
  })

  return unsubscribe
}

const configureTokenIndex = async (
  rootUri: string,
  tokenIndex: TokenIndex,
  onDestroy: Array<() => Promise<void>>,
) => {
  await scanAndIndexTokens(rootUri, tokenIndex)
  const unsubscribe = await attachWatcher(rootUri, tokenIndex)
  onDestroy.push(unsubscribe)
}

export const startServer = (): void => {
  const conn = createConnection(ProposedFeatures.all)
  const docs = new TextDocuments(TextDocument)

  // will hold tokenName -> value + position etc
  // On init, fill it with defined tokens
  // On update to the configured files, update the values
  const tokenIndex: TokenIndex = new Map()
  const onDestroy: Array<() => Promise<void>> = []

  conn.onInitialize(async (params) => {
    if (params.workspaceFolders) {
      for (const workspace of params.workspaceFolders) {
        await configureTokenIndex(workspace.uri, tokenIndex, onDestroy)
      }
    } else if (params.rootUri) {
      await configureTokenIndex(params.rootUri, tokenIndex, onDestroy)
    } else if (params.rootPath) {
      await configureTokenIndex(params.rootPath, tokenIndex, onDestroy)
    }

    return { capabilities: { hoverProvider: true, inlayHintProvider: true } }
  })

  conn.onHover(async ({ textDocument, position }) => {
    return { contents: { kind: "markdown", value: "## Token Value\nred" } }
  })

  conn.onShutdown(async () => {
    for (const destroy of onDestroy) {
      try {
        await destroy()
      } catch (err) {}
    }
  })

  console.debug("Starting Antd Language Server...")
  docs.listen(conn)
  conn.listen()
}
