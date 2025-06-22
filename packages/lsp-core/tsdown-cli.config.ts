import { defineConfig } from "tsdown"
import baseConfig from "./tsdown.config"

export default defineConfig({
  ...baseConfig,
  entry: "./src/cli.ts",
  minify: true,
  format: "cjs",
  outDir: "dist-cli",
  unbundle: false,
  noExternal: [
    "vscode-languageserver/node",
    "vscode-languageserver-textdocument",
  ],
})
