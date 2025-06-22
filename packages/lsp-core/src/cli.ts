#!/usr/bin/env node
import { AntdLs } from "./server.js"

const server = AntdLs.create()

server.start().catch((err) => {
  console.error("Failed to start AntdLs:", err)
})
