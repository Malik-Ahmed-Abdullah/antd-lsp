import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["./src/**/*.ts"],
  platform: "node",
  format: ["cjs", "esm"],
  sourcemap: true,
  clean: true,
  target: "node20",
  outDir: "dist",
  minify: false,
  unbundle: true,
  treeshake: true,
  // dts: true,
  dts: {
    isolatedDeclarations: true, // will use oxc to generate dts files
  },
  external: ["vscode"],
})
