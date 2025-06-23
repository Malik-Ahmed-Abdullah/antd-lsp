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
    documentSelector: [{ scheme: "file", language: "typescript" }],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher("**/*.{json,ts}"),
    },
    progressOnInitialization: false, // support later on
  }

  client = new LanguageClient("antd-ls", serverOptions, clientOptions)

  await client.start()
  context.subscriptions.push(client)
}

export const deactivate = async (): Promise<void> => {
  if (!client) return

  return client.stop()
}
