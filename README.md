## Antd Language Server

### Dev setup

Install [mise](https://mise.jdx.dev/getting-started.html) followed by

```sh
mise install
```

to install `bun` and other tools, and then `bun install` in the root directory
to install all the required packages.

- `mise run package` to create the vsix file which you can install in vscode (or
  compatible editors like Windsurf) - Can be used to test the "production" build
- For debugging, setup the breakpoints or debugger statements and run the
  "Extension + LSP Server (Debug)" task to launch a new window with the debug
  build of the extension loaded and LS attached. A simple test would be to add a
  breakpoint in "onHover" method in server.ts and launch the extension, open a
  .ts file and hover over a variable
