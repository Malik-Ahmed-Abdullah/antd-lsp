import type { Position } from "vscode-languageserver"

type TokenName = string
export type TokenData = {
  uri: string
  value: string
  position: Position
}

export type TokenIndex = Map<TokenName, TokenData>

export const scanAndIndexTokens = async (
  rootUri: string,
  tokenIndex: TokenIndex,
): Promise<void> => {}
