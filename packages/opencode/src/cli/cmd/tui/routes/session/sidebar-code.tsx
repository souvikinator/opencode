import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, Show, For, type Accessor, createEffect, on } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme, tint } from "@tui/context/theme"
import { useKeybind } from "@tui/context/keybind"
import { useDirectory } from "@tui/context/directory"
import { useKeyboard } from "@opentui/solid"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import path from "path"
import { createPatch } from "diff"
import { useDialog } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"

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
  comment?: string
  absolutePath?: string
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
): { displayLine: number; fileLine: number; type: "context" | "add" | "remove" | "header" }[] {
  const mapping: { displayLine: number; fileLine: number; type: "context" | "add" | "remove" | "header" }[] = []
  const lines = patch.split("\n")
  let displayLine = 0
  let fileLine = 0

  for (const line of lines) {
    // Match hunk header to get starting line number
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      fileLine = parseInt(hunkMatch[1], 10)
      mapping.push({ displayLine, fileLine: -1, type: "header" })
      displayLine++
      continue
    }

    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) {
      mapping.push({ displayLine, fileLine: -1, type: "header" })
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
    } else {
      // Fallback for other lines
      mapping.push({ displayLine, fileLine: -1, type: "header" })
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
  const dialog = useDialog()

  let previewScroll: ScrollBoxRenderable | undefined
  const diffs = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const activeEdits = createMemo(() => sync.data.active_edits[props.sessionID] ?? [])
  const lastEdit = createMemo(() => sync.data.last_edit[props.sessionID])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [trackHeight, setTrackHeight] = createSignal(20)

  const [trackChanges, setTrackChanges] = createSignal(true)

  // Line selection state for adding context
  const [selectedLineStart, setSelectedLineStart] = createSignal<number | null>(null)
  const [selectedLineEnd, setSelectedLineEnd] = createSignal<number | null>(null)
  const [cursorLine, setCursorLine] = createSignal(0)
  const [visualMode, setVisualMode] = createSignal(false)
  const [isShiftDown, setIsShiftDown] = createSignal(false)
  const [isInteracting, setIsInteracting] = createSignal(false)

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
      setVisualMode(false)
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

  createEffect(() => {
    const edit = lastEdit()
    if (!trackChanges() || !edit) return

    const list = diffs()
    const fileIndex = list.findIndex((d) => d.file === edit.file)
    if (fileIndex >= 0 && fileIndex !== selectedIndex()) {
      setSelectedIndex(fileIndex)
    }
  })

  createEffect(() => {
    const edit = lastEdit()
    if (!trackChanges() || !edit?.line || !previewScroll) return

    const file = selectedFile()
    if (!file || file.file !== edit.file) return

    const mapping = lineMapping()
    const displayLine = mapping.find((m) => m.fileLine === edit.line && m.type === "add")
    if (displayLine) {
      previewScroll.scrollTo(Math.max(0, displayLine.displayLine - 5))
      setCursorLine(displayLine.displayLine)
    }
  })

  // Get the line mapping for current file
  const unifiedContent = createMemo(() => {
    const file = selectedFile()
    if (!file) return ""

    const before = file.before || ""
    const after = file.after || ""

    const maxLines = Math.max(before.split("\n").length, after.split("\n").length)
    const patch = createPatch(file.file, before, after, "", "", { context: maxLines })
    return patch
  })

  const lineMapping = createMemo(() => parseDiffLineMapping(unifiedContent()))

  // Map for fast lookup: displayLine -> info
  const lineInfoMap = createMemo(() => {
    const map = new Map<number, { fileLine: number; type: string }>()
    lineMapping().forEach((m) => map.set(m.displayLine, { fileLine: m.fileLine, type: m.type }))
    return map
  })

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

  const handleAddContext = async (withComment = false) => {
    const ref = getSelectedContent()
    if (!ref) return

    let comment: string | null = null
    if (withComment) {
      setIsInteracting(true)
      comment = await DialogPrompt.show(dialog, `Add comment for ${ref.file}:${ref.startLine}-${ref.endLine}`, {
        placeholder: "What would you like to ask about this code?",
      })
      setIsInteracting(false)
      dialog.clear() // Explicitly clear dialog after interaction
      if (comment === null) return // Cancelled
    }

    if (props.onAddContext) {
      props.onAddContext({
        ...ref,
        comment: comment ?? undefined,
        absolutePath: path.resolve(sync.data.path.worktree, ref.file),
      })
      // Clear selection after adding
      setSelectedLineStart(null)
      setSelectedLineEnd(null)
      setVisualMode(false)
    }
  }

  useKeyboard((evt) => {
    // Track shift key state
    if (evt.shift !== undefined) {
      setIsShiftDown(evt.shift)
    }

    if (!focused() || isInteracting()) return

    if (evt.name === "escape") {
      // Clear selection first, then unfocus
      if (selectedLineStart() !== null || visualMode()) {
        setSelectedLineStart(null)
        setSelectedLineEnd(null)
        setVisualMode(false)
        return
      }
      return
    }

    // Toggle Visual Mode
    if (evt.name === "v") {
      setVisualMode((prev) => !prev)
      if (!visualMode()) {
        // Turning ON (prev was false)
        if (selectedLineStart() === null) {
          const line = cursorLine()
          setSelectedLineStart(line)
          setSelectedLineEnd(null)
        }
      }
      return
    }

    // Toggle Track Changes mode with 't'
    if (evt.name === "t") {
      setTrackChanges((prev) => !prev)
      return
    }

    // File navigation (when NOT in visual mode and NOT holding shift)
    if (!visualMode() && !evt.shift && selectedLineStart() === null) {
      if (keybind.match("sidebar_up", evt)) {
        setSelectedIndex((prev) => Math.max(0, prev - 1))
        return
      }
      if (keybind.match("sidebar_down", evt)) {
        setSelectedIndex((prev) => Math.min(diffs().length - 1, prev + 1))
        return
      }
    }

    // Code Cursor / Selection Navigation
    if (evt.name === "j" || evt.name === "down") {
      setCursorLine((prev) => Math.min(prev + 1, totalLines() - 1))
      // Adjust scroll if cursor moves out of view
      if (cursorLine() > (previewScroll?.y ?? 0) + (trackHeight() - 2)) {
        previewScroll?.scrollBy(1)
      }

      if (visualMode() || evt.shift) {
        if (selectedLineStart() === null) setSelectedLineStart(cursorLine() - 1) // Start from previous
        setSelectedLineEnd(cursorLine())
      } else if (selectedLineStart() !== null && !evt.shift) {
        setSelectedLineStart(null)
        setSelectedLineEnd(null)
      }
      return
    }

    if (evt.name === "k" || evt.name === "up") {
      setCursorLine((prev) => Math.max(0, prev - 1))
      if (cursorLine() < (previewScroll?.y ?? 0)) {
        previewScroll?.scrollBy(-1)
      }

      if (visualMode() || evt.shift) {
        if (selectedLineStart() === null) setSelectedLineStart(cursorLine() + 1)
        setSelectedLineEnd(cursorLine())
      } else if (selectedLineStart() !== null && !evt.shift) {
        setSelectedLineStart(null)
        setSelectedLineEnd(null)
      }
      return
    }

    // 'c' to comment on selection
    if (evt.name === "c" && selectedLineStart() !== null) {
      handleAddContext(true)
      return
    }

    // 'a' or 'Enter' to add
    if ((evt.name === "a" || evt.name === "return") && selectedLineStart() !== null) {
      handleAddContext(false)
      return
    }

    if (evt.name === "pageup") {
      previewScroll?.scrollBy(-10)
      setCursorLine((prev) => Math.max(0, prev - 10))
      return
    }
    if (evt.name === "pagedown") {
      previewScroll?.scrollBy(10)
      setCursorLine((prev) => Math.min(totalLines() - 1, prev + 10))
      return
    }
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
    setCursorLine(line)
  }

  const markers = createMemo(() => {
    const height = trackHeight()
    const total = totalLines()
    if (height <= 0 || total <= 0) return []

    // If content fits in the view, use 1:1 mapping (no scaling)
    // If content overflows, scale it down to fit the track height (minimap style)
    const scale = total > height ? height / total : 1

    const grouped: { position: number; type: "add" | "remove" | "mixed"; line: number }[] = []
    const hunkList = hunks()

    for (const hunk of hunkList) {
      const position = Math.floor(hunk.line * scale)
      const last = grouped[grouped.length - 1]
      if (last && last.position === position) {
        if (last.type !== hunk.type) last.type = "mixed"
      } else {
        grouped.push({ position, type: hunk.type, line: hunk.line })
      }
    }

    return grouped
  })

  const isLineSelected = (line: number) => {
    const start = selectedLineStart()
    if (start === null) return false

    const info = lineInfoMap().get(line)
    if (info?.fileLine === -1) return false

    const end = selectedLineEnd() ?? start
    const minLine = Math.min(start, end)
    const maxLine = Math.max(start, end)
    return line >= minLine && line <= maxLine
  }

  // Handle mouse click on line
  const handleLineClick = (lineIndex: number, shiftKey: boolean) => {
    setCursorLine(lineIndex)
    if (shiftKey && selectedLineStart() !== null) {
      setSelectedLineEnd(lineIndex)
    } else {
      setSelectedLineStart(lineIndex)
      setSelectedLineEnd(null)
    }
  }

  // Helper to get actual file line number from display index
  const getDisplayLineNumber = (index: number) => {
    const info = lineInfoMap().get(index)
    if (!info || info.fileLine === -1) return null
    return info.fileLine
  }

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      onMouseUp={() => props.onFocus?.()}
      border={["left", "right", "top", "bottom"]}
      borderColor={focused() ? theme.accent : theme.backgroundPanel}
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
          <box flexGrow={1} />
          <box paddingRight={1}>
            <text fg={trackChanges() ? theme.success : theme.textMuted}>{trackChanges() ? "● Track" : "○ Track"}</text>
          </box>
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
                const isActiveEdit = createMemo(() => {
                  const active = activeEdits()
                  const worktree = sync.data.path.worktree
                  return active.some((activePath) => {
                    const relativeActivePath =
                      worktree && activePath.startsWith(worktree)
                        ? activePath.slice(worktree.length).replace(/^\//, "")
                        : activePath
                    return (
                      relativeActivePath === item.file ||
                      activePath.endsWith("/" + item.file) ||
                      item.file === activePath
                    )
                  })
                })

                const bgColor = createMemo(() => {
                  if (isActiveEdit()) return theme.warning
                  if (selected()) return theme.accent
                  return undefined
                })

                const textColor = createMemo(() => {
                  if (isActiveEdit()) return theme.background
                  if (selected()) return theme.background
                  return theme.text
                })

                const borderColor = createMemo(() => {
                  if (selected() && isActiveEdit()) return theme.accent
                  return undefined
                })

                return (
                  <box
                    flexDirection="row"
                    paddingLeft={1}
                    backgroundColor={bgColor()}
                    border={borderColor() ? ["left"] : undefined}
                    borderColor={borderColor()}
                    onMouseUp={() => {
                      setSelectedIndex(index())
                      props.onFocus?.()
                    }}
                  >
                    <Show when={isActiveEdit()}>
                      <text fg={theme.background}>● </text>
                    </Show>
                    <text fg={textColor()}>{item.file}</text>
                    <box flexGrow={1} />
                    <box flexDirection="row" paddingRight={1} gap={1}>
                      <Show when={item.additions}>
                        <text fg={selected() || isActiveEdit() ? theme.background : theme.success}>
                          +{item.additions}
                        </text>
                      </Show>
                      <Show when={item.deletions}>
                        <text fg={selected() || isActiveEdit() ? theme.background : theme.error}>
                          -{item.deletions}
                        </text>
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
          {/* Help / Status Bar */}
          <box
            height={1}
            paddingLeft={1}
            marginBottom={1}
            backgroundColor={selectedLineStart() !== null ? theme.accent : theme.backgroundPanel}
          >
            <Show
              when={selectedLineStart() !== null}
              fallback={
                <text fg={theme.textMuted}>
                  <span style={{ fg: theme.accent }}>v</span>=visual | <span style={{ fg: theme.accent }}>j/k</span>
                  =move | <span style={{ fg: theme.accent }}>t</span>=track |{" "}
                  <span style={{ fg: theme.accent }}>Click</span>=select
                </text>
              }
            >
              {(() => {
                const start = selectedLineStart()!
                const end = selectedLineEnd() ?? start
                const min = Math.min(start, end)
                const max = Math.max(start, end)

                const minLine = getDisplayLineNumber(min) ?? "?"
                const maxLine = getDisplayLineNumber(max) ?? "?"

                return (
                  <text fg={theme.background}>
                    Sel: {minLine}
                    {min !== max ? `-${maxLine}` : ""} | <span style={{ fg: theme.background, bold: true }}>c</span>
                    =comment | <span style={{ fg: theme.background, bold: true }}>Enter</span>=add
                  </text>
                )
              })()}
            </Show>
          </box>

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
              <For each={unifiedContent().split("\n")}>
                {(line, index) => {
                  const info = createMemo(() => lineInfoMap().get(index()) ?? { fileLine: -1, type: "header" })
                  const isSelected = createMemo(() => isLineSelected(index()))
                  const isCursor = createMemo(() => cursorLine() === index())

                  const bg = createMemo(() => {
                    if (isSelected()) return tint(theme.background, theme.accent, 0.3)
                    if (isCursor() && focused()) return theme.backgroundElement // highlighting cursor line
                    return undefined
                  })

                  const fgColor = createMemo(() => {
                    if (info().type === "add") return theme.success
                    if (info().type === "remove") return theme.error
                    if (info().type === "header") return theme.textMuted
                    return theme.text
                  })

                  return (
                    <Show when={info().type !== "header"}>
                      <box
                        flexDirection="row"
                        backgroundColor={bg()}
                        onMouseUp={() => handleLineClick(index(), isShiftDown())}
                      >
                        {/* Line Number Column */}
                        <box width={5} paddingRight={1} alignItems="flex-end" flexShrink={0}>
                          <text
                            fg={theme.textMuted}
                            attributes={info().fileLine === -1 ? TextAttributes.DIM : undefined}
                          >
                            {info().fileLine > 0 ? info().fileLine.toString() : " "}
                          </text>
                        </box>
                        {/* Content Column */}
                        <box flexGrow={1}>
                          <text fg={fgColor()}>{line}</text>
                        </box>
                      </box>
                    </Show>
                  )
                }}
              </For>
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
                      marker.type === "add" ? theme.success : marker.type === "remove" ? theme.error : theme.warning
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
              <span style={{ fg: theme.success }}>+{selectedFile()!.additions || 0}</span>{" "}
              <span style={{ fg: theme.error }}>-{selectedFile()!.deletions || 0}</span>
            </text>
          </box>
        </Show>
      </box>
    </box>
  )
}
