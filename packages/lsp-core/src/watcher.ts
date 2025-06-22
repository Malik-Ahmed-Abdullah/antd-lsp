import watcher from "@parcel/watcher"
import type { TokenIndex } from "./scanner"

export const attachWatcher = async (
  rootUri: string,
  tokenIndex: TokenIndex,
): Promise<() => Promise<void>> => {
  const { unsubscribe } = await watcher.subscribe(rootUri, (err, events) => {
    for (const event of events) {
      switch (event.type) {
        case "create": {
          break
        }
        case "update": {
          break
        }
        case "delete": {
          break
        }
        default: {
          throw new Error(`Unknown event type: ${event.type}`)
        }
      }
    }
  })

  return unsubscribe
}
