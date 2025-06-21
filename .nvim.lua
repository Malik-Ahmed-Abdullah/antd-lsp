vim.notify("Configuring antls")
---@type vim.lsp.Config
local cfg = {
	filetypes = { "typescript" },
	root_markers = { "package.json", ".git" },
	name = "antls",
	cmd = { "node", "./packages/lsp-core/dist/cli.js", "--stdio" },
}

vim.lsp.config("antls", cfg)
vim.lsp.enable("antls", false)
