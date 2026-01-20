import { ScrollBoxRenderable } from "@opentui/core"
import { createMemo, createSignal, Show, For, type Accessor, createEffect, on } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useKeybind } from "@tui/context/keybind"
import { useKeyboard } from "@opentui/solid"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import path from "path"
import { createPatch } from "diff"

type HunkInfo = {
  line: number
  type: "add" | "remove" | "mixed"
}

// Parse diff to extract hunk line positions
function parseHunks(patch: string): HunkInfo[] {
  const hunks: HunkInfo[] = []
  const lines = patch.split("\n")
  let lineNum = 0

  for (const line of lines) {
    // Match hunk header
    if (line.startsWith("@@")) {
      lineNum++
      continue
    }

    // Skip diff headers
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) {
      lineNum++
      continue
    }

    // Track added/removed lines
    if (line.startsWith("+") && !line.startsWith("+++")) {
      hunks.push({ line: lineNum, type: "add" })
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      hunks.push({ line: lineNum, type: "remove" })
    }
    lineNum++
  }

  return hunks
}

export function SidebarCode(props: { sessionID: string; focused?: Accessor<boolean>; onFocus?: () => void }) {
  const sync = useSync()
  const { theme } = useTheme()
  const keybind = useKeybind()

  let previewScroll: ScrollBoxRenderable | undefined
  const diffs = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [trackHeight, setTrackHeight] = createSignal(20)

  const focused = createMemo(() => props.focused?.() ?? false)

  const selectedFile = createMemo(() => {
    const list = diffs()
    const idx = selectedIndex()
    if (idx >= 0 && idx < list.length) return list[idx]
    return list[0]
  })

  createEffect(
    on(diffs, (list) => {
      if (list.length === 0) {
        setSelectedIndex(0)
      } else if (selectedIndex() >= list.length) {
        setSelectedIndex(list.length - 1)
      }
    }),
  )

  useKeyboard((evt) => {
    if (!focused()) return

    if (evt.name === "escape") return

    if (keybind.match("sidebar_up", evt)) {
      setSelectedIndex((prev) => Math.max(0, prev - 1))
      return
    }
    if (keybind.match("sidebar_down", evt)) {
      setSelectedIndex((prev) => Math.min(diffs().length - 1, prev + 1))
      return
    }

    if (evt.name === "pageup") {
      previewScroll?.scrollBy(-10)
      return
    }
    if (evt.name === "pagedown") {
      previewScroll?.scrollBy(10)
      return
    }
  })

  const fileType = createMemo(() => {
    const file = selectedFile()
    if (!file) return "none"
    const ext = path.extname(file.file)
    const language = LANGUAGE_EXTENSIONS[ext]
    if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
    return language
  })

  const unifiedContent = createMemo(() => {
    const file = selectedFile()
    if (!file) return ""

    const before = file.before || ""
    const after = file.after || ""

    const maxLines = Math.max(before.split("\n").length, after.split("\n").length)
    const patch = createPatch(file.file, before, after, "", "", { context: maxLines })
    return patch
  })

  const hunks = createMemo(() => parseHunks(unifiedContent()))

  const totalLines = createMemo(() => {
    const content = unifiedContent()
    if (!content) return 1
    return Math.max(content.split("\n").length, 1)
  })

  const fileListHeight = createMemo(() => Math.min(Math.max(diffs().length, 1) + 2, 12))
  const hasFiles = createMemo(() => diffs().length > 0)

  function jumpToLine(line: number) {
    if (!previewScroll) return
    previewScroll.scrollTo(line)
  }

  // Compute marker positions for the scroll track
  const markers = createMemo(() => {
    const height = trackHeight()
    const total = totalLines()
    if (height <= 0 || total <= 0) return []

    // Group consecutive hunks of same type
    const grouped: { position: number; type: "add" | "remove" | "mixed"; line: number }[] = []
    const hunkList = hunks()

    for (const hunk of hunkList) {
      const position = Math.floor((hunk.line / total) * height)
      // Check if we can merge with previous marker at same position
      const last = grouped[grouped.length - 1]
      if (last && last.position === position) {
        if (last.type !== hunk.type) last.type = "mixed"
      } else {
        grouped.push({ position, type: hunk.type, line: hunk.line })
      }
    }

    return grouped
  })

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      onMouseUp={() => props.onFocus?.()}
      border={focused() ? ["left", "right", "top", "bottom"] : undefined}
      borderColor={focused() ? theme.accent : theme.border}
    >
      {/* File List Pane */}
      <box height={fileListHeight()} border={["bottom"]} borderColor={theme.border} paddingBottom={0} flexShrink={0}>
        <box height={1} paddingLeft={1} backgroundColor={theme.backgroundElement} flexDirection="row">
          <text fg={theme.textMuted}>
            Modified Files ({diffs().length})
            <Show when={focused()}>
              <span style={{ fg: theme.accent }}> [focused]</span>
            </Show>
          </text>
        </box>
        <scrollbox flexGrow={1}>
          <Show
            when={hasFiles()}
            fallback={
              <box padding={1}>
                <text fg={theme.textMuted}>No changes yet.</text>
              </box>
            }
          >
            <For each={diffs()}>
              {(item, index) => {
                const selected = createMemo(() => index() === selectedIndex())
                return (
                  <box
                    flexDirection="row"
                    paddingLeft={1}
                    backgroundColor={selected() ? theme.accent : undefined}
                    onMouseUp={() => {
                      setSelectedIndex(index())
                      props.onFocus?.()
                    }}
                  >
                    <text fg={selected() ? theme.background : theme.text}>{item.file}</text>
                    <box flexGrow={1} />
                    <box flexDirection="row" paddingRight={1} gap={1}>
                      <Show when={item.additions}>
                        <text fg={selected() ? theme.background : theme.diffAdded}>+{item.additions}</text>
                      </Show>
                      <Show when={item.deletions}>
                        <text fg={selected() ? theme.background : theme.diffRemoved}>-{item.deletions}</text>
                      </Show>
                    </box>
                  </box>
                )
              }}
            </For>
          </Show>
        </scrollbox>
      </box>

      {/* Preview Pane */}
      <box flexGrow={1} flexDirection="column">
        <Show
          when={selectedFile()}
          fallback={
            <box padding={1} flexGrow={1}>
              <text fg={theme.textMuted}>Select a file to view changes</text>
            </box>
          }
        >
          <box flexGrow={1} flexDirection="row">
            {/* Diff content */}
            <scrollbox
              flexGrow={1}
              ref={(el) => (previewScroll = el)}
              viewportOptions={{ paddingRight: 1 }}
              verticalScrollbarOptions={{
                visible: true,
                trackOptions: {
                  backgroundColor: theme.backgroundElement,
                  foregroundColor: theme.border,
                },
              }}
            >
              <diff diff={unifiedContent()} />
            </scrollbox>

            {/* Change indicators strip */}
            <box
              width={1}
              flexShrink={0}
              backgroundColor={theme.backgroundElement}
              ref={(el) => {
                createEffect(() => {
                  if (el) setTrackHeight(el.height || 20)
                })
              }}
            >
              <For each={markers()}>
                {(marker) => (
                  <box
                    position="absolute"
                    top={marker.position}
                    left={0}
                    width={1}
                    height={1}
                    backgroundColor={
                      marker.type === "add"
                        ? theme.diffAdded
                        : marker.type === "remove"
                          ? theme.diffRemoved
                          : theme.warning
                    }
                    onMouseUp={() => jumpToLine(marker.line)}
                  />
                )}
              </For>
            </box>
          </box>

          {/* Footer */}
          <box
            height={1}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.backgroundElement}
            flexDirection="row"
            justifyContent="space-between"
            flexShrink={0}
          >
            <text fg={theme.text}>{selectedFile()!.file}</text>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.diffAdded }}>+{selectedFile()!.additions || 0}</span>{" "}
              <span style={{ fg: theme.diffRemoved }}>-{selectedFile()!.deletions || 0}</span>
            </text>
          </box>
        </Show>
      </box>
    </box>
  )
}
