import * as path from "node:path"
import { type ExtensionContext, workspace } from "vscode"
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node"

let client: LanguageClient | undefined

export const activate = async (context: ExtensionContext): Promise<void> => {
  // Later on, we should add an option to pick the path from settings, and/or download the server automatically.
  const serverModule = context.asAbsolutePath(path.join("dist", "cli.cjs"))

  const serverOptions: ServerOptions = {
    run: {
      transport: TransportKind.ipc,
      module: serverModule,
    },
    debug: {
      transport: TransportKind.ipc,
      module: serverModule,
      options: {
        execArgv: ["--inspect=6009", "--enable-source-maps"],
      },
    },
  }

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "typescript" },
      { scheme: "file", language: "typescriptreact" },
      { scheme: "file", language: "javascript" },
      { scheme: "file", language: "javascriptreact" },
      { scheme: "file", language: "json" },
    ],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher("**/*.{ts,tsx,js,jsx,json}")
    },
    initializationOptions: {},
    progressOnInitialization: true,
  };


  client = new LanguageClient("antd-ls", serverOptions, clientOptions)

  await client.start()
  context.subscriptions.push(client)
}

export const deactivate = async (): Promise<void> => {
  if (!client) return

  return client.stop()
}
