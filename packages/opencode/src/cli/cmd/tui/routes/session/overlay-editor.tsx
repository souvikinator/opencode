import { InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, Show, For, createEffect, on, batch, createSelector } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme, tint } from "@tui/context/theme"
import { useKeybind } from "@tui/context/keybind"
import { useKeyboard } from "@opentui/solid"
import path from "path"
import { createPatch } from "diff"
import { useDialog } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"
import type { CodeReference } from "./sidebar-code"

type HunkInfo = {
  line: number
  type: "add" | "remove" | "mixed"
}

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

function parseDiffLineMapping(
  patch: string,
): { displayLine: number; fileLine: number; type: "context" | "add" | "remove" | "header" }[] {
  const mapping: { displayLine: number; fileLine: number; type: "context" | "add" | "remove" | "header" }[] = []
  const lines = patch.split("\n")
  let displayLine = 0
  let fileLine = 0

  for (const line of lines) {
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
      mapping.push({ displayLine, fileLine: -1, type: "remove" })
      displayLine++
    } else if (line.startsWith(" ") || line === "") {
      mapping.push({ displayLine, fileLine, type: "context" })
      fileLine++
      displayLine++
    } else {
      mapping.push({ displayLine, fileLine: -1, type: "header" })
      displayLine++
    }
  }

  return mapping
}

export function OverlayEditor(props: {
  sessionID: string
  selectedFile: string | null
  onAddContext?: (ref: CodeReference) => void
  onClose: () => void
  onOpenFinder: () => void
}) {
  const sync = useSync()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dialog = useDialog()

  let previewScroll: ScrollBoxRenderable | undefined
  const diffs = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const activeEdits = createMemo(() => sync.data.active_edits[props.sessionID] ?? [])
  const [trackHeight, setTrackHeight] = createSignal(20)

  const [trackChanges, setTrackChanges] = createSignal(true)
  const [showDiff, setShowDiff] = createSignal(true)
  const [fileContent, setFileContent] = createSignal<string | null>(null)

  const [selectedLineStart, setSelectedLineStart] = createSignal<number | null>(null)
  const [selectedLineEnd, setSelectedLineEnd] = createSignal<number | null>(null)
  const [cursorLine, setCursorLine] = createSignal(0)
  const isCursorLine = createSelector(cursorLine)
  const [visualMode, setVisualMode] = createSignal(false)
  const [isShiftDown, setIsShiftDown] = createSignal(false)
  const [isInteracting, setIsInteracting] = createSignal(false)

  const selectedDiffFile = createMemo(() => {
    const filePath = props.selectedFile
    if (!filePath) return diffs()[0]
    return diffs().find((d) => d.file === filePath)
  })

  const selectedFile = createMemo(() => {
    const diffFile = selectedDiffFile()
    if (diffFile) return diffFile

    const filePath = props.selectedFile
    if (filePath && fileContent() !== null) {
      return {
        file: filePath,
        before: "",
        after: fileContent() || "",
        additions: 0,
        deletions: 0,
      }
    }

    return diffs()[0]
  })

  // Load file content for non-diff files
  createEffect(
    on(
      () => props.selectedFile,
      async (filePath) => {
        if (!filePath) {
          setFileContent(null)
          return
        }

        const isDiffFile = diffs().some((d) => d.file === filePath)
        if (isDiffFile) {
          setFileContent(null)
          return
        }

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
      },
    ),
  )

  const isDiffView = createMemo(() => {
    if (!showDiff()) return false
    const diff = selectedDiffFile()
    return !!diff
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

  const displayContent = createMemo(() => {
    if (isDiffView()) {
      return unifiedContent()
    }
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
  const allLines = createMemo(() => displayContent().split("\n"))
  const hunks = createMemo(() => (isDiffView() ? parseHunks(unifiedContent()) : []))

  const lineInfoMap = createMemo(() => {
    const map = new Map<number, { fileLine: number; type: string }>()
    lineMapping().forEach((m) => map.set(m.displayLine, { fileLine: m.fileLine, type: m.type }))
    return map
  })

  const getLineInfo = (index: number) => {
    if (isDiffView()) {
      return lineInfoMap().get(index) ?? { fileLine: -1, type: "header" }
    }
    return { fileLine: index + 1, type: "context" as const }
  }

  const getDisplayLineNumber = (index: number) => {
    const info = lineInfoMap().get(index)
    if (!info || info.fileLine === -1) return null
    return info.fileLine
  }

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

  const handleLineClick = (lineIndex: number, shiftKey: boolean) => {
    setCursorLine(lineIndex)
    if (shiftKey && selectedLineStart() !== null) {
      setSelectedLineEnd(lineIndex)
    } else {
      setSelectedLineStart(lineIndex)
      setSelectedLineEnd(null)
    }
  }

  const getSelectedContent = () => {
    const file = selectedFile()
    if (!file) return null

    const start = selectedLineStart()
    if (start === null) return null
    const end = selectedLineEnd() ?? start

    const minLine = Math.min(start, end)
    const maxLine = Math.max(start, end)

    const afterLines = file.after.split("\n")
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
      dialog.clear()
      if (comment === null) return
    }

    if (props.onAddContext) {
      props.onAddContext({
        ...ref,
        comment: comment ?? undefined,
        absolutePath: path.resolve(sync.data.path.worktree, ref.file),
      })
      setSelectedLineStart(null)
      setSelectedLineEnd(null)
      setVisualMode(false)
    }
  }

  useKeyboard((evt) => {
    if (evt.shift !== undefined) {
      setIsShiftDown(evt.shift)
    }

    if (isInteracting()) return

    if (evt.name === "escape") {
      if (selectedLineStart() !== null || visualMode()) {
        setSelectedLineStart(null)
        setSelectedLineEnd(null)
        setVisualMode(false)
        return
      }
      props.onClose()
      return
    }

    if (evt.ctrl && evt.shift && evt.name === "f") {
      props.onOpenFinder()
      return
    }

    if (evt.name === "v" && !evt.ctrl) {
      setVisualMode((prev) => !prev)
      if (!visualMode()) {
        if (selectedLineStart() === null) {
          const line = cursorLine()
          setSelectedLineStart(line)
          setSelectedLineEnd(null)
        }
      }
      return
    }

    if (evt.name === "t" && !evt.ctrl) {
      setTrackChanges((prev) => !prev)
      return
    }

    if (evt.name === "d" && !evt.ctrl && !visualMode() && selectedLineStart() === null) {
      setShowDiff((prev) => !prev)
      return
    }

    if (evt.name === "j" || evt.name === "down") {
      const prev = cursorLine()
      const next = Math.min(prev + 1, totalLines() - 1)
      setCursorLine(next)

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

    if (evt.name === "c" && selectedLineStart() !== null) {
      handleAddContext(true)
      return
    }

    if ((evt.name === "a" || evt.name === "return") && selectedLineStart() !== null) {
      handleAddContext(false)
      return
    }
  })

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
      position="absolute"
      top={0}
      left={0}
      right={0}
      height="60%"
      flexDirection="column"
      backgroundColor={theme.background}
      border={["bottom"]}
      borderColor={theme.border}
      zIndex={90}
    >
      <Show
        when={selectedFile()}
        fallback={
          <box padding={1} flexGrow={1} flexDirection="column" alignItems="center" justifyContent="center">
            <text fg={theme.textMuted}>No file selected</text>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.accent }}>ctrl+shift+f</span> to open file finder
            </text>
          </box>
        }
      >
        {/* Header */}
        <box
          height={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={isFileActiveEdit() ? theme.warning : theme.backgroundElement}
          flexDirection="row"
          justifyContent="space-between"
          flexShrink={0}
        >
          <text fg={isFileActiveEdit() ? theme.background : theme.text}>{selectedFile()!.file}</text>
          <box flexDirection="row" gap={1}>
            <text fg={isDiffView() ? theme.success : theme.textMuted}>{isDiffView() ? "[d]iff" : "d"}</text>
            <text fg={trackChanges() ? theme.success : theme.textMuted}>{trackChanges() ? "[t]rack" : "t"}</text>
          </box>
        </box>

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

        {/* Code content */}
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
            <For each={allLines()}>
              {(line, index) => {
                const lineNum = index()
                const info = createMemo(() => getLineInfo(lineNum))
                const isSelected = createMemo(() => isLineSelected(lineNum))
                const isCursor = () => isCursorLine(lineNum)

                const bg = createMemo(() => {
                  if (isSelected()) return tint(theme.background, theme.accent, 0.3)
                  if (isCursor()) return theme.backgroundElement
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
                        <text fg={theme.textMuted} attributes={info().fileLine === -1 ? TextAttributes.DIM : undefined}>
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

          {/* Change indicators strip */}
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
            />
          </Show>
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
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.accent }}>ctrl+shift+f</span> files
          </text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.accent }}>v</span> select <span style={{ fg: theme.accent }}>esc</span> close
          </text>
        </box>
      </Show>
    </box>
  )
}
