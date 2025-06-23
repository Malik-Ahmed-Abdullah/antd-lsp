#!/usr/bin/env node
import { AntdLs } from "@carbonteq/antd-lsp-core"

const server = AntdLs.create()
server.start().catch(console.error)
