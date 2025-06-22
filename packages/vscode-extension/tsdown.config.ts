import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    extension: "./src/extension.ts",
    cli: "./src/cli.ts",
  },
  platform: "node",
  format: "cjs",
  sourcemap: false,
  clean: true,
  outDir: "dist",
  minify: true,
  unbundle: false,
  treeshake: true,
  dts: false,
  external: ["vscode"],
  // check https://tsdown.dev/options/dependencies
  noExternal: ["vscode-languageclient/node", "@carbonteq/antd-lsp-core"],
})
