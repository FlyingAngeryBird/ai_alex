export type DismissiblePanelState = {
  settingsOpen: boolean
  itemsOpen: boolean
  memoryOpen: boolean
  historyOpen: boolean
  searchOpen: boolean
}

/** True when Escape should dismiss a side/search panel rather than reaching the page. */
export function hasDismissiblePanel(state: DismissiblePanelState): boolean {
  return state.settingsOpen || state.itemsOpen || state.memoryOpen || state.historyOpen || state.searchOpen
}
