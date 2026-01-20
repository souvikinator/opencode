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

// Represents a code reference to be added to chat
export type CodeReference = {
  file: string
  startLine: number
  endLine: number
  content: string
}

// Parse diff to extract hunk line positions
function parseHunks(patch: string): HunkInfo[] {
  const hunks: HunkInfo[] = []
  const lines = patch.split("\n")
  let lineNum = 0

  for (const line of lines) {
    if (line.startsWith("@@")) {
      lineNum++
      continue
    }

    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) {
      lineNum++
      continue
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      hunks.push({ line: lineNum, type: "add" })
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      hunks.push({ line: lineNum, type: "remove" })
    }
    lineNum++
  }

  return hunks
}

// Parse diff content to map display lines to actual file lines
function parseDiffLineMapping(
  patch: string,
): { displayLine: number; fileLine: number; type: "context" | "add" | "remove" }[] {
  const mapping: { displayLine: number; fileLine: number; type: "context" | "add" | "remove" }[] = []
  const lines = patch.split("\n")
  let displayLine = 0
  let fileLine = 0

  for (const line of lines) {
    // Match hunk header to get starting line number
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      fileLine = parseInt(hunkMatch[1], 10)
      displayLine++
      continue
    }

    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) {
      displayLine++
      continue
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      mapping.push({ displayLine, fileLine, type: "add" })
      fileLine++
      displayLine++
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      mapping.push({ displayLine, fileLine: -1, type: "remove" }) // removed lines don't exist in new file
      displayLine++
    } else if (line.startsWith(" ") || line === "") {
      mapping.push({ displayLine, fileLine, type: "context" })
      fileLine++
      displayLine++
    }
  }

  return mapping
}

export function SidebarCode(props: {
  sessionID: string
  focused?: Accessor<boolean>
  onFocus?: () => void
  onAddContext?: (ref: CodeReference) => void
}) {
  const sync = useSync()
  const { theme } = useTheme()
  const keybind = useKeybind()

  let previewScroll: ScrollBoxRenderable | undefined
  const diffs = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [trackHeight, setTrackHeight] = createSignal(20)

  // Line selection state for adding context
  const [selectedLineStart, setSelectedLineStart] = createSignal<number | null>(null)
  const [selectedLineEnd, setSelectedLineEnd] = createSignal<number | null>(null)
  const [cursorLine, setCursorLine] = createSignal(0)

  const focused = createMemo(() => props.focused?.() ?? false)

  const selectedFile = createMemo(() => {
    const list = diffs()
    const idx = selectedIndex()
    if (idx >= 0 && idx < list.length) return list[idx]
    return list[0]
  })

  // Reset line selection when file changes
  createEffect(
    on(selectedFile, () => {
      setSelectedLineStart(null)
      setSelectedLineEnd(null)
      setCursorLine(0)
    }),
  )

  createEffect(
    on(diffs, (list) => {
      if (list.length === 0) {
        setSelectedIndex(0)
      } else if (selectedIndex() >= list.length) {
        setSelectedIndex(list.length - 1)
      }
    }),
  )

  // Get the line mapping for current file
  const lineMapping = createMemo(() => parseDiffLineMapping(unifiedContent()))

  // Get content for selected lines
  const getSelectedContent = () => {
    const file = selectedFile()
    if (!file) return null

    const start = selectedLineStart()
    if (start === null) return null
    const end = selectedLineEnd() ?? start

    const minLine = Math.min(start, end)
    const maxLine = Math.max(start, end)

    // Get the actual file lines from the "after" content
    const afterLines = file.after.split("\n")

    // Map display lines to file lines
    const mapping = lineMapping()
    const fileLines: number[] = []

    for (let displayLine = minLine; displayLine <= maxLine; displayLine++) {
      const entry = mapping.find((m) => m.displayLine === displayLine)
      if (entry && entry.fileLine > 0) {
        fileLines.push(entry.fileLine)
      }
    }

    if (fileLines.length === 0) return null

    const startFileLine = Math.min(...fileLines)
    const endFileLine = Math.max(...fileLines)

    // Extract content (1-indexed to 0-indexed)
    const content = afterLines.slice(startFileLine - 1, endFileLine).join("\n")

    return {
      file: file.file,
      startLine: startFileLine,
      endLine: endFileLine,
      content,
    }
  }

  useKeyboard((evt) => {
    if (!focused()) return

    if (evt.name === "escape") {
      // Clear selection first, then unfocus
      if (selectedLineStart() !== null) {
        setSelectedLineStart(null)
        setSelectedLineEnd(null)
        return
      }
      return
    }

    // File navigation (when not in line selection mode)
    if (selectedLineStart() === null) {
      if (keybind.match("sidebar_up", evt)) {
        setSelectedIndex((prev) => Math.max(0, prev - 1))
        return
      }
      if (keybind.match("sidebar_down", evt)) {
        setSelectedIndex((prev) => Math.min(diffs().length - 1, prev + 1))
        return
      }
    }

    // Enter line selection mode or navigate within it
    if (evt.name === "j" || evt.name === "down") {
      if (selectedLineStart() !== null) {
        // Extend/move selection
        setCursorLine((prev) => Math.min(prev + 1, totalLines() - 1))
        if (evt.shift) {
          setSelectedLineEnd(cursorLine() + 1)
        } else {
          setSelectedLineStart(cursorLine() + 1)
          setSelectedLineEnd(null)
        }
      }
      return
    }

    if (evt.name === "k" || evt.name === "up") {
      if (selectedLineStart() !== null) {
        setCursorLine((prev) => Math.max(0, prev - 1))
        if (evt.shift) {
          setSelectedLineEnd(cursorLine() - 1)
        } else {
          setSelectedLineStart(cursorLine() - 1)
          setSelectedLineEnd(null)
        }
      }
      return
    }

    // 'l' or 'Enter' to start line selection mode
    if (evt.name === "l" || evt.name === "return") {
      if (selectedLineStart() === null) {
        // Enter line selection mode at current scroll position
        const line = previewScroll?.y ?? 0
        setSelectedLineStart(line)
        setSelectedLineEnd(null)
        setCursorLine(line)
        return
      }
    }

    // 'a' to add selected context to chat
    if (evt.name === "a" || (evt.name === "return" && selectedLineStart() !== null)) {
      const ref = getSelectedContent()
      if (ref && props.onAddContext) {
        props.onAddContext(ref)
        // Clear selection after adding
        setSelectedLineStart(null)
        setSelectedLineEnd(null)
      }
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

  const markers = createMemo(() => {
    const height = trackHeight()
    const total = totalLines()
    if (height <= 0 || total <= 0) return []

    const grouped: { position: number; type: "add" | "remove" | "mixed"; line: number }[] = []
    const hunkList = hunks()

    for (const hunk of hunkList) {
      const position = Math.floor((hunk.line / total) * height)
      const last = grouped[grouped.length - 1]
      if (last && last.position === position) {
        if (last.type !== hunk.type) last.type = "mixed"
      } else {
        grouped.push({ position, type: hunk.type, line: hunk.line })
      }
    }

    return grouped
  })

  // Check if a line is in the selection range
  const isLineSelected = (line: number) => {
    const start = selectedLineStart()
    if (start === null) return false
    const end = selectedLineEnd() ?? start
    const minLine = Math.min(start, end)
    const maxLine = Math.max(start, end)
    return line >= minLine && line <= maxLine
  }

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
          {/* Help text for line selection */}
          <Show when={focused() && selectedLineStart() === null}>
            <box height={1} paddingLeft={1} backgroundColor={theme.backgroundPanel}>
              <text fg={theme.textMuted}>
                Press <span style={{ fg: theme.accent }}>l</span> or <span style={{ fg: theme.accent }}>Enter</span> to
                select lines, then <span style={{ fg: theme.accent }}>a</span> to add to chat
              </text>
            </box>
          </Show>
          <Show when={selectedLineStart() !== null}>
            <box height={1} paddingLeft={1} backgroundColor={theme.accent}>
              <text fg={theme.background}>
                Line {selectedLineStart()}
                {selectedLineEnd() !== null ? `-${selectedLineEnd()}` : ""} selected |{" "}
                <span style={{ fg: theme.background }}>a</span>=add to chat |{" "}
                <span style={{ fg: theme.background }}>Esc</span>=cancel
              </text>
            </box>
          </Show>

          <box flexGrow={1} flexDirection="row">
            <scrollbox
              flexGrow={1}
              ref={(el) => (previewScroll = el)}
              viewportOptions={{ paddingRight: 1 }}
              verticalScrollbarOptions={{
                visible: true,
                trackOptions: { backgroundColor: theme.backgroundElement, foregroundColor: theme.border },
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
