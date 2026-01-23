import { createMemo, createSignal, For, Show, createEffect } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useKeyboard } from "@opentui/solid"
import { InputRenderable } from "@opentui/core"

export function OverlayFileFinder(props: { sessionID: string; onSelect: (file: string) => void; onClose: () => void }) {
  const sync = useSync()
  const { theme } = useTheme()
  const [searchQuery, setSearchQuery] = createSignal("")
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  let searchInput: InputRenderable | undefined

  const diffs = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])

  // Auto-focus search input
  createEffect(() => {
    setTimeout(() => searchInput?.focus(), 10)
  })

  const filteredFiles = createMemo(() => {
    const query = searchQuery().toLowerCase()
    if (!query) return diffs()
    return diffs().filter((d) => d.file.toLowerCase().includes(query))
  })

  // Reset selection when filter changes
  createMemo(() => {
    filteredFiles()
    setSelectedIndex(0)
  })

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      props.onClose()
      return
    }

    if (evt.name === "up" || evt.name === "k") {
      setSelectedIndex((i) => Math.max(0, i - 1))
      return
    }

    if (evt.name === "down" || evt.name === "j") {
      setSelectedIndex((i) => Math.min(filteredFiles().length - 1, i + 1))
      return
    }

    if (evt.name === "return") {
      const file = filteredFiles()[selectedIndex()]
      if (file) {
        props.onSelect(file.file)
      }
      return
    }
  })

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      flexDirection="column"
      backgroundColor={theme.background}
      border={["bottom"]}
      borderColor={theme.border}
      zIndex={100}
    >
      {/* Search input */}
      <box
        height={1}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.backgroundElement}
        flexDirection="row"
        gap={1}
        alignItems="center"
      >
        <text fg={theme.textMuted}>🔍</text>
        <input
          ref={(el) => (searchInput = el)}
          value={searchQuery()}
          onInput={(val) => setSearchQuery(val)}
          flexGrow={1}
          placeholder="Search files..."
          focusedBackgroundColor={theme.backgroundElement}
          cursorColor={theme.primary}
          focusedTextColor={theme.text}
        />
        <text fg={theme.textMuted}>ESC=close</text>
      </box>

      {/* File list */}
      <box flexDirection="column" maxHeight={10} flexShrink={0}>
        <Show
          when={filteredFiles().length > 0}
          fallback={
            <box paddingLeft={2} paddingTop={1} paddingBottom={1}>
              <text fg={theme.textMuted}>No files found</text>
            </box>
          }
        >
          <For each={filteredFiles()}>
            {(item, index) => {
              const isSelected = createMemo(() => index() === selectedIndex())
              return (
                <box
                  flexDirection="row"
                  paddingLeft={2}
                  paddingRight={2}
                  paddingTop={0}
                  paddingBottom={0}
                  backgroundColor={isSelected() ? theme.primary : undefined}
                  justifyContent="space-between"
                  onMouseUp={() => props.onSelect(item.file)}
                  onMouseOver={() => setSelectedIndex(index())}
                >
                  <text fg={isSelected() ? theme.background : theme.text} flexGrow={1}>
                    {item.file}
                  </text>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <Show when={item.additions}>
                      <text fg={isSelected() ? theme.background : theme.success}>+{item.additions}</text>
                    </Show>
                    <Show when={item.deletions}>
                      <text fg={isSelected() ? theme.background : theme.error}>-{item.deletions}</text>
                    </Show>
                  </box>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </box>
  )
}
