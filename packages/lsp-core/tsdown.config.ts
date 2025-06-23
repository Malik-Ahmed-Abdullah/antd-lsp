import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["./src/**/*.ts", "!src/cli.ts"],
  platform: "node",
  format: ["cjs", "esm"],
  sourcemap: false,
  clean: true,
  target: "node20",
  outDir: "dist",
  minify: true,
  unbundle: true,
  treeshake: true,
  removeNodeProtocol: true,
  // dts: true,
  dts: {
    isolatedDeclarations: true, // will use oxc to generate dts files
  },
})
