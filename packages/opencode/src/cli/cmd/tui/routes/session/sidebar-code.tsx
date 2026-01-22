import { InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, Show, For, type Accessor, createEffect, on, batch, createSelector } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme, tint } from "@tui/context/theme"
import { useKeybind } from "@tui/context/keybind"
import { useKeyboard } from "@opentui/solid"
import path from "path"
import { createPatch } from "diff"
import { useDialog } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { DialogFileExplorer } from "./dialog-file-explorer"

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
  let searchInput: InputRenderable | undefined
  const diffs = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const activeEdits = createMemo(() => sync.data.active_edits[props.sessionID] ?? [])
  const lastEdit = createMemo(() => sync.data.last_edit[props.sessionID])
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [trackHeight, setTrackHeight] = createSignal(20)

  const [trackChanges, setTrackChanges] = createSignal(true)
  const [showDiff, setShowDiff] = createSignal(true)
  const [fileListExpanded, setFileListExpanded] = createSignal(false)
  const [fileListIndex, setFileListIndex] = createSignal(0)

  // In-editor search state
  const [searchMode, setSearchMode] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [searchMatches, setSearchMatches] = createSignal<number[]>([])
  const searchMatchesSet = createMemo(() => new Set(searchMatches()))
  const [currentMatchIndex, setCurrentMatchIndex] = createSignal(0)

  // Selected file path (can be a diff file or any file from explorer)
  const [selectedFilePath, setSelectedFilePath] = createSignal<string | null>(null)
  const [fileContent, setFileContent] = createSignal<string | null>(null)

  // Line selection state for adding context
  const [selectedLineStart, setSelectedLineStart] = createSignal<number | null>(null)
  const [selectedLineEnd, setSelectedLineEnd] = createSignal<number | null>(null)
  const [cursorLine, setCursorLine] = createSignal(0)
  const isCursorLine = createSelector(cursorLine)
  const [visualMode, setVisualMode] = createSignal(false)
  const [isShiftDown, setIsShiftDown] = createSignal(false)
  const [isInteracting, setIsInteracting] = createSignal(false)
  const [scrollY, setScrollY] = createSignal(0)

  const focused = createMemo(() => props.focused?.() ?? false)

  // Get selected diff file (if any)
  const selectedDiffFile = createMemo(() => {
    const filePath = selectedFilePath()
    if (!filePath) {
      // Fallback to first diff if no file selected
      const list = diffs()
      return list[0]
    }
    return diffs().find((d) => d.file === filePath)
  })

  // The currently displayed file info
  const selectedFile = createMemo(() => {
    const diffFile = selectedDiffFile()
    if (diffFile) return diffFile

    // If we have a non-diff file selected, return a placeholder
    const filePath = selectedFilePath()
    if (filePath && fileContent() !== null) {
      return {
        file: filePath,
        before: "",
        after: fileContent() || "",
        additions: 0,
        deletions: 0,
      }
    }

    // Fallback to first diff
    const list = diffs()
    const idx = selectedIndex()
    if (idx >= 0 && idx < list.length) return list[idx]
    return list[0]
  })

  // Load file content when a non-diff file is selected
  createEffect(
    on(selectedFilePath, async (filePath) => {
      if (!filePath) {
        setFileContent(null)
        return
      }

      // Check if this is a diff file
      const isDiffFile = diffs().some((d) => d.file === filePath)
      if (isDiffFile) {
        setFileContent(null)
        return
      }

      // Load file content
      const worktree = sync.data.path.worktree
      if (!worktree) {
        setFileContent(null)
        return
      }

      const fullPath = path.resolve(worktree, filePath)
      try {
        const file = Bun.file(fullPath)
        const content = await file.text()
        setFileContent(content)
      } catch {
        setFileContent(null)
      }
    }),
  )

  // Handle file selection from file explorer
  const handleFileSelect = (filePath: string) => {
    batch(() => {
      setSelectedFilePath(filePath)
      // Update selectedIndex if it's a diff file
      const idx = diffs().findIndex((d) => d.file === filePath)
      if (idx >= 0) {
        setSelectedIndex(idx)
        setFileListIndex(idx)
      }
      // Reset view state
      setCursorLine(0)
      setSelectedLineStart(null)
      setSelectedLineEnd(null)
      setVisualMode(false)
      setFileListExpanded(false)
      previewScroll?.scrollTo(0)
    })
    dialog.clear()
  }

  // Open file explorer dialog
  const openFileExplorer = () => {
    setIsInteracting(true)
    dialog.replace(
      () => (
        <DialogFileExplorer
          sessionID={props.sessionID}
          currentFile={selectedFilePath() || selectedFile()?.file}
          onSelect={handleFileSelect}
        />
      ),
      () => setIsInteracting(false),
    )
  }

  // Determine if we're showing diff or regular content
  const isDiffView = createMemo(() => {
    if (!showDiff()) return false
    const diff = selectedDiffFile()
    return !!diff
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

  // Content to display (either diff or raw file content)
  const displayContent = createMemo(() => {
    if (isDiffView()) {
      return unifiedContent()
    }
    // For non-diff view, show the after content or loaded file content
    const file = selectedFile()
    if (!file) return ""
    return file.after || ""
  })

  const totalLines = createMemo(() => {
    const content = displayContent()
    if (!content) return 1
    return Math.max(content.split("\n").length, 1)
  })

  const lineMapping = createMemo(() => parseDiffLineMapping(unifiedContent()))

  // Track scroll position for virtualization
  createEffect(() => {
    if (!previewScroll) return
    const updateScroll = () => setScrollY(previewScroll?.y ?? 0)
    updateScroll()
    const interval = setInterval(updateScroll, 50)
    return () => clearInterval(interval)
  })

  // Reset scroll when file changes
  createEffect(
    on(selectedFile, () => {
      setScrollY(0)
      setCursorLine(0)
      setSelectedLineStart(null)
      setSelectedLineEnd(null)
      setVisualMode(false)
      setSearchMode(false)
      setSearchQuery("")
      setSearchMatches([])
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
      batch(() => {
        setSelectedIndex(fileIndex)
        setSelectedFilePath(edit.file)
        setFileListIndex(fileIndex)
      })
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

  // Search functionality - find matches
  createEffect(
    on([searchQuery, displayContent], ([query, content]) => {
      if (!query || !content) {
        setSearchMatches([])
        setCurrentMatchIndex(0)
        return
      }

      const lines = content.split("\n")
      const matches: number[] = []
      const lowerQuery = query.toLowerCase()

      lines.forEach((line: string, index: number) => {
        if (line.toLowerCase().includes(lowerQuery)) {
          matches.push(index)
        }
      })

      setSearchMatches(matches)
      setCurrentMatchIndex(0)

      // Jump to first match
      if (matches.length > 0 && previewScroll) {
        previewScroll.scrollTo(Math.max(0, matches[0] - 3))
        setCursorLine(matches[0])
      }
    }),
  )

  // Navigate to next/previous search match
  const navigateSearch = (direction: 1 | -1) => {
    const matches = searchMatches()
    if (matches.length === 0) return

    let nextIndex = currentMatchIndex() + direction
    if (nextIndex < 0) nextIndex = matches.length - 1
    if (nextIndex >= matches.length) nextIndex = 0

    setCurrentMatchIndex(nextIndex)
    const line = matches[nextIndex]
    if (previewScroll) {
      previewScroll.scrollTo(Math.max(0, line - 3))
      setCursorLine(line)
    }
  }

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

    // Let global keybinds pass through (sidebar toggle, etc)
    if (keybind.match("sidebar_mode_toggle", evt) || keybind.match("sidebar_toggle", evt)) {
      return
    }

    // Search mode keyboard handling
    if (searchMode()) {
      if (evt.name === "escape") {
        setSearchMode(false)
        setSearchQuery("")
        setSearchMatches([])
        return
      }
      if (evt.ctrl && evt.name === "f") {
        setSearchMode(false)
        return
      }
      if (evt.name === "return" || (evt.ctrl && evt.name === "n")) {
        navigateSearch(1)
        return
      }
      if (evt.ctrl && evt.name === "p") {
        navigateSearch(-1)
        return
      }
      // Let input handle other keys
      return
    }

    // Ctrl+F - Toggle in-editor search
    if (evt.ctrl && evt.name === "f") {
      setSearchMode(true)
      setTimeout(() => searchInput?.focus(), 10)
      return
    }

    if (evt.name === "escape") {
      // Close file list first
      if (fileListExpanded()) {
        setFileListExpanded(false)
        return
      }
      // Clear selection first, then exit search, then unfocus
      if (selectedLineStart() !== null || visualMode()) {
        setSelectedLineStart(null)
        setSelectedLineEnd(null)
        setVisualMode(false)
        return
      }
      return
    }

    // File list navigation when expanded
    if (fileListExpanded()) {
      if (evt.name === "up" || evt.name === "k") {
        setFileListIndex((i) => Math.max(0, i - 1))
        return
      }
      if (evt.name === "down" || evt.name === "j") {
        setFileListIndex((i) => Math.min(diffs().length - 1, i + 1))
        return
      }
      if (evt.name === "return") {
        const file = diffs()[fileListIndex()]
        if (file) {
          setSelectedFilePath(file.file)
          setSelectedIndex(fileListIndex())
          setFileListExpanded(false)
        }
        return
      }
      return
    }

    // 'e' - Toggle file list expansion
    if (evt.name === "e" && !evt.ctrl && !visualMode() && selectedLineStart() === null && diffs().length > 0) {
      setFileListExpanded((v) => !v)
      setFileListIndex(diffs().findIndex((d) => d.file === selectedFile()?.file) || 0)
      return
    }

    // Ctrl+Shift+F - Open file explorer
    if (evt.ctrl && evt.shift && evt.name === "f") {
      openFileExplorer()
      return
    }

    // Ctrl+F - Toggle in-editor search
    if (evt.ctrl && evt.name === "f") {
      setSearchMode(true)
      setTimeout(() => searchInput?.focus(), 10)
      return
    }

    // 'd' - Toggle diff view
    if (evt.name === "d" && !evt.ctrl && !visualMode() && selectedLineStart() === null) {
      setShowDiff((prev) => !prev)
      return
    }

    // 'f' - Open file explorer (alternative)
    if (evt.name === "f" && !evt.ctrl && !visualMode() && selectedLineStart() === null) {
      openFileExplorer()
      return
    }

    // Toggle Visual Mode
    if (evt.name === "v" && !evt.ctrl) {
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
    if (evt.name === "t" && !evt.ctrl) {
      setTrackChanges((prev) => !prev)
      return
    }

    // Code Cursor / Selection Navigation
    if (evt.name === "j" || evt.name === "down") {
      const prev = cursorLine()
      const next = Math.min(prev + 1, totalLines() - 1)
      setCursorLine(next)

      // Adjust scroll if cursor moves out of view
      const scrollY = previewScroll?.y ?? 0
      const viewHeight = trackHeight() - 2
      if (next > scrollY + viewHeight) {
        previewScroll?.scrollTo(next - viewHeight)
      }

      if (visualMode() || evt.shift) {
        if (selectedLineStart() === null) setSelectedLineStart(prev)
        setSelectedLineEnd(next)
      } else if (selectedLineStart() !== null && !evt.shift) {
        setSelectedLineStart(null)
        setSelectedLineEnd(null)
      }
      return
    }

    if (evt.name === "k" || evt.name === "up") {
      const prev = cursorLine()
      const next = Math.max(0, prev - 1)
      setCursorLine(next)

      const scrollY = previewScroll?.y ?? 0
      if (next < scrollY) {
        previewScroll?.scrollTo(next)
      }

      if (visualMode() || evt.shift) {
        if (selectedLineStart() === null) setSelectedLineStart(prev)
        setSelectedLineEnd(next)
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

  // Pre-compute all lines once to avoid repeated splits
  const allLines = createMemo(() => displayContent().split("\n"))

  const hunks = createMemo(() => (isDiffView() ? parseHunks(unifiedContent()) : []))

  // Check if line matches search query - use Set for O(1) lookup
  const isSearchMatch = (lineIndex: number) => {
    return searchMatchesSet().has(lineIndex)
  }

  const isCurrentSearchMatch = (lineIndex: number) => {
    const matches = searchMatches()
    if (matches.length === 0) return false
    return matches[currentMatchIndex()] === lineIndex
  }

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
    if (!focused()) return
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

  // Helper to get line info for non-diff view
  const getLineInfo = (index: number) => {
    if (isDiffView()) {
      return lineInfoMap().get(index) ?? { fileLine: -1, type: "header" }
    }
    // For non-diff view, line number is just index + 1
    return { fileLine: index + 1, type: "context" as const }
  }

  // Check if file is being actively edited
  const isFileActiveEdit = createMemo(() => {
    const file = selectedFile()
    if (!file) return false
    const active = activeEdits()
    const worktree = sync.data.path.worktree
    return active.some((activePath) => {
      const relativeActivePath =
        worktree && activePath.startsWith(worktree) ? activePath.slice(worktree.length).replace(/^\//, "") : activePath
      return relativeActivePath === file.file || activePath.endsWith("/" + file.file) || file.file === activePath
    })
  })

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      onMouseUp={() => props.onFocus?.()}
      border={focused() ? ["left"] : undefined}
      borderColor={theme.accent}
    >
      {/* Code Preview Pane - Full Height */}
      <box flexGrow={1} flexDirection="column">
        <Show
          when={selectedFile()}
          fallback={
            <box padding={1} flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
              <text fg={theme.textMuted}>No file selected</text>
              <text fg={theme.textMuted}>
                <span style={{ fg: theme.accent }}>f</span> files <span style={{ fg: theme.accent }}>e</span> list{" "}
                <span style={{ fg: theme.accent }}>v</span> select
              </text>
            </box>
          }
        >
          {/* Search Bar (when active) */}
          <Show when={searchMode()}>
            <box
              height={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.backgroundElement}
              flexDirection="row"
              gap={1}
              flexShrink={0}
            >
              <text fg={theme.textMuted}>Search:</text>
              <input
                ref={(el) => (searchInput = el)}
                value={searchQuery()}
                onInput={(val) => setSearchQuery(val)}
                flexGrow={1}
                focusedBackgroundColor={theme.backgroundElement}
                cursorColor={theme.primary}
                focusedTextColor={theme.text}
              />
              <Show when={searchMatches().length > 0}>
                <text fg={theme.textMuted}>
                  {currentMatchIndex() + 1}/{searchMatches().length}
                </text>
              </Show>
              <text fg={theme.textMuted}>Enter=next Esc=close</text>
            </box>
          </Show>

          {/* Help / Status Bar */}
          <Show when={selectedLineStart() === null}>
            <box
              height={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.backgroundElement}
              flexDirection="row"
              justifyContent="space-between"
              flexShrink={0}
            >
              <text fg={focused() ? theme.text : theme.textMuted}>
                <span style={{ fg: theme.accent }}>{keybind.print("sidebar_focus")}</span> focus{" "}
                <span style={{ fg: theme.accent }}>f</span> files <span style={{ fg: theme.accent }}>^f</span> search{" "}
                <span style={{ fg: theme.accent }}>v</span> select
              </text>
              <box flexDirection="row" gap={1}>
                <text fg={isDiffView() ? theme.success : theme.textMuted}>{isDiffView() ? "[d]iff" : "d"}</text>
                <text fg={trackChanges() ? theme.success : theme.textMuted}>{trackChanges() ? "[t]rack" : "t"}</text>
              </box>
            </box>
          </Show>

          {/* Selection Mode Bar */}
          <Show when={selectedLineStart() !== null}>
            <box
              height={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.accent}
              flexDirection="row"
              justifyContent="space-between"
              flexShrink={0}
            >
              {(() => {
                const start = selectedLineStart()!
                const end = selectedLineEnd() ?? start
                const min = Math.min(start, end)
                const max = Math.max(start, end)
                const minLine = getDisplayLineNumber(min) ?? "?"
                const maxLine = getDisplayLineNumber(max) ?? "?"

                return (
                  <>
                    <text fg={theme.background}>
                      Lines {minLine}
                      {min !== max ? `-${maxLine}` : ""}
                    </text>
                    <text fg={theme.background}>
                      <span style={{ bold: true }}>c</span> comment <span style={{ bold: true }}>Enter</span> add{" "}
                      <span style={{ bold: true }}>Esc</span> cancel
                    </text>
                  </>
                )
              })()}
            </box>
          </Show>

          <box flexGrow={1} flexDirection="row" paddingTop={1}>
            <scrollbox
              flexGrow={1}
              ref={(el) => (previewScroll = el)}
              viewportOptions={{ paddingRight: 1 }}
              verticalScrollbarOptions={{
                visible: true,
                trackOptions: { backgroundColor: theme.backgroundElement, foregroundColor: theme.border },
              }}
            >
              <For each={allLines()}>
                {(line, index) => {
                  const lineNum = index()
                  const info = createMemo(() => getLineInfo(lineNum))
                  const isSelected = createMemo(() => isLineSelected(lineNum))
                  const isCursor = () => isCursorLine(lineNum)
                  const isMatch = createMemo(() => searchMatchesSet().has(lineNum))
                  const isCurrentMatch = createMemo(() => isCurrentSearchMatch(lineNum))

                  const bg = createMemo(() => {
                    if (isSelected()) return tint(theme.background, theme.accent, 0.3)
                    if (isCurrentMatch()) return tint(theme.background, theme.warning, 0.4)
                    if (isMatch()) return tint(theme.background, theme.warning, 0.15)
                    if (isCursor() && focused()) return theme.backgroundElement
                    return undefined
                  })

                  const fgColor = createMemo(() => {
                    if (isDiffView()) {
                      if (info().type === "add") return theme.success
                      if (info().type === "remove") return theme.error
                      if (info().type === "header") return theme.textMuted
                    }
                    return theme.text
                  })

                  const shouldShow = createMemo(() => {
                    if (!isDiffView()) return true
                    return info().type !== "header"
                  })

                  return (
                    <Show when={shouldShow()}>
                      <box
                        flexDirection="row"
                        backgroundColor={bg()}
                        onMouseUp={() => handleLineClick(lineNum, isShiftDown())}
                      >
                        <box width={6} paddingLeft={1} paddingRight={1} alignItems="flex-end" flexShrink={0}>
                          <text
                            fg={theme.textMuted}
                            attributes={info().fileLine === -1 ? TextAttributes.DIM : undefined}
                          >
                            {info().fileLine > 0 ? info().fileLine.toString() : " "}
                          </text>
                        </box>
                        <Show when={isDiffView()}>
                          <box width={1} flexShrink={0}>
                            <text
                              fg={
                                info().type === "add"
                                  ? theme.success
                                  : info().type === "remove"
                                    ? theme.error
                                    : theme.textMuted
                              }
                            >
                              {info().type === "add" ? "+" : info().type === "remove" ? "-" : " "}
                            </text>
                          </box>
                        </Show>
                        <box flexGrow={1} paddingLeft={1}>
                          <text fg={fgColor()}>{isDiffView() && line.length > 0 ? line.slice(1) : line}</text>
                        </box>
                      </box>
                    </Show>
                  )
                }}
              </For>
            </scrollbox>

            {/* Change indicators strip (only in diff view) */}
            <Show when={isDiffView()}>
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
            </Show>
          </box>

          {/* Expanded File List (above footer) */}
          <Show when={fileListExpanded() && diffs().length > 0}>
            <box
              flexDirection="column"
              maxHeight={8}
              flexShrink={0}
              backgroundColor={theme.background}
              border={["top"]}
              borderColor={theme.border}
            >
              <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
                <For each={diffs()}>
                  {(item, index) => {
                    const isSelected = createMemo(() => index() === fileListIndex())
                    const isCurrent = createMemo(() => item.file === selectedFile()?.file)
                    const isEditing = createMemo(() => {
                      const active = activeEdits()
                      const worktree = sync.data.path.worktree
                      return active.some((p) => {
                        const rel = worktree && p.startsWith(worktree) ? p.slice(worktree.length).replace(/^\//, "") : p
                        return rel === item.file || p.endsWith("/" + item.file)
                      })
                    })

                    return (
                      <box
                        flexDirection="row"
                        paddingLeft={isCurrent() ? 1 : 3}
                        paddingRight={1}
                        backgroundColor={isSelected() ? theme.primary : undefined}
                        onMouseUp={() => {
                          setSelectedFilePath(item.file)
                          setSelectedIndex(index())
                          setFileListExpanded(false)
                        }}
                        onMouseOver={() => setFileListIndex(index())}
                      >
                        <Show when={isCurrent()}>
                          <text fg={isSelected() ? theme.background : theme.primary}>● </text>
                        </Show>
                        <text
                          fg={isSelected() ? theme.background : isEditing() ? theme.warning : theme.text}
                          flexGrow={1}
                        >
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
              </scrollbox>
            </box>
          </Show>

          {/* Footer */}
          <box
            height={1}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={isFileActiveEdit() ? theme.warning : theme.backgroundElement}
            flexDirection="row"
            justifyContent="space-between"
            flexShrink={0}
            onMouseUp={() => {
              if (diffs().length > 0) setFileListExpanded((v) => !v)
            }}
          >
            <Show
              when={!fileListExpanded()}
              fallback={
                <box flexDirection="row" gap={1}>
                  <text fg={focused() ? theme.text : theme.textMuted}>▼</text>
                  <text fg={focused() ? theme.text : theme.textMuted}>Close file list</text>
                </box>
              }
            >
              <box flexDirection="row" gap={1}>
                {/* Toggle arrow */}
                <Show when={diffs().length > 0}>
                  <text fg={isFileActiveEdit() ? theme.background : focused() ? theme.text : theme.textMuted}>▶</text>
                </Show>
                <Show when={isFileActiveEdit()}>
                  <text fg={theme.background}>●</text>
                </Show>
                <text fg={isFileActiveEdit() ? theme.background : focused() ? theme.text : theme.textMuted}>
                  {selectedFile()!.file}
                </text>
              </box>
              <box flexDirection="row" gap={2}>
                <Show when={diffs().length > 1}>
                  <text fg={isFileActiveEdit() ? theme.background : focused() ? theme.text : theme.textMuted}>
                    {(() => {
                      const idx = diffs().findIndex((d) => d.file === selectedFile()?.file)
                      return `${idx >= 0 ? idx + 1 : 1} / ${diffs().length}`
                    })()}
                  </text>
                </Show>
                <Show when={selectedDiffFile()}>
                  <text fg={isFileActiveEdit() ? theme.background : focused() ? theme.text : theme.textMuted}>
                    <span
                      style={{
                        fg: isFileActiveEdit() ? theme.background : focused() ? theme.success : theme.textMuted,
                      }}
                    >
                      +{selectedFile()!.additions || 0}
                    </span>
                    {"  "}
                    <span
                      style={{
                        fg: isFileActiveEdit() ? theme.background : focused() ? theme.error : theme.textMuted,
                      }}
                    >
                      {selectedFile()!.deletions ? `-${selectedFile()!.deletions}` : "0"}
                    </span>
                  </text>
                </Show>
              </box>
            </Show>
          </box>
        </Show>
      </box>
    </box>
  )
}
