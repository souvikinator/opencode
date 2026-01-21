import { InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, createEffect, Show, For, on, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme, selectedForeground } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useKeyboard } from "@opentui/solid"
import { Ripgrep } from "@/file/ripgrep"
import fuzzysort from "fuzzysort"
import path from "path"

type DisplayItem = {
  name: string
  path: string
  isDir: boolean
  expanded: boolean
  depth: number
  additions?: number
  deletions?: number
}

type ViewMode = "tree" | "changed"

export function DialogFileExplorer(props: {
  sessionID: string
  currentFile?: string
  onSelect: (filePath: string) => void
}) {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()

  let inputRef: InputRenderable | undefined
  let scrollRef: ScrollBoxRenderable | undefined

  const [search, setSearch] = createSignal("")
  const [selectedIndex, setSelectedIndex] = createSignal(0)
  const [files, setFiles] = createSignal<string[]>([])
  const [loading, setLoading] = createSignal(true)
  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(new Set())
  const [viewMode, setViewMode] = createSignal<ViewMode>("tree")

  const changedFiles = createMemo(() => {
    const diffs = sync.data.session_diff[props.sessionID] ?? []
    return diffs.map((d) => ({
      file: d.file,
      additions: d.additions || 0,
      deletions: d.deletions || 0,
    }))
  })

  const activeEdits = createMemo(() => sync.data.active_edits[props.sessionID] ?? [])

  const isActiveEdit = (filePath: string) => {
    const active = activeEdits()
    const worktree = sync.data.path.worktree
    return active.some((p) => {
      const rel = worktree && p.startsWith(worktree) ? p.slice(worktree.length).replace(/^\//, "") : p
      return rel === filePath || p.endsWith("/" + filePath) || filePath === p
    })
  }

  onMount(async () => {
    dialog.setSize("large")
    const worktree = sync.data.path.worktree
    if (!worktree) {
      setLoading(false)
      return
    }

    const fileList: string[] = []
    try {
      for await (const file of Ripgrep.files({ cwd: worktree })) {
        fileList.push(file)
        if (fileList.length >= 5000) break
      }
    } catch (e) {
      console.error("Failed to load files:", e)
    }
    setFiles(fileList)
    setLoading(false)
    setTimeout(() => inputRef?.focus(), 10)
  })

  // Build flattened tree view
  const treeItems = createMemo(() => {
    const fileList = files()
    const expanded = expandedDirs()
    const result: DisplayItem[] = []

    // Build directory structure
    const dirs = new Map<string, Set<string>>() // parent -> children names
    const filePaths = new Set<string>()

    for (const file of fileList) {
      filePaths.add(file)
      const parts = file.split(path.sep)
      let current = ""
      for (let i = 0; i < parts.length - 1; i++) {
        const parent = current
        current = current ? `${current}${path.sep}${parts[i]}` : parts[i]
        if (!dirs.has(parent)) dirs.set(parent, new Set())
        dirs.get(parent)!.add(parts[i])
      }
      // Add file to its parent
      const parent = parts.slice(0, -1).join(path.sep)
      if (!dirs.has(parent)) dirs.set(parent, new Set())
      dirs.get(parent)!.add(parts[parts.length - 1])
    }

    // Recursive flatten
    const flatten = (parentPath: string, depth: number) => {
      const children = dirs.get(parentPath)
      if (!children) return

      const sorted = [...children].sort((a, b) => {
        const aPath = parentPath ? `${parentPath}${path.sep}${a}` : a
        const bPath = parentPath ? `${parentPath}${path.sep}${b}` : b
        const aIsDir = dirs.has(aPath)
        const bIsDir = dirs.has(bPath)
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
        return a.localeCompare(b)
      })

      for (const name of sorted) {
        const itemPath = parentPath ? `${parentPath}${path.sep}${name}` : name
        const isDir = dirs.has(itemPath)
        const isExpanded = expanded.has(itemPath)

        result.push({
          name,
          path: itemPath,
          isDir,
          expanded: isExpanded,
          depth,
        })

        if (isDir && isExpanded) {
          flatten(itemPath, depth + 1)
        }
      }
    }

    flatten("", 0)
    return result
  })

  const displayItems = createMemo((): DisplayItem[] => {
    const query = search().trim()

    if (query) {
      const allFiles = files().map((f) => ({ path: f, name: path.basename(f) }))
      const results = fuzzysort.go(query, allFiles, { keys: ["path", "name"], limit: 100 })
      return results.map((r) => ({
        name: r.obj.name,
        path: r.obj.path,
        isDir: false,
        expanded: false,
        depth: 0,
      }))
    }

    if (viewMode() === "changed") {
      return changedFiles().map((f) => ({
        name: path.basename(f.file),
        path: f.file,
        isDir: false,
        expanded: false,
        depth: 0,
        additions: f.additions,
        deletions: f.deletions,
      }))
    }

    return treeItems()
  })

  createEffect(
    on(displayItems, (items) => {
      if (selectedIndex() >= items.length) {
        setSelectedIndex(Math.max(0, items.length - 1))
      }
    }),
  )

  createEffect(
    on([search, viewMode], () => {
      setSelectedIndex(0)
      scrollRef?.scrollTo(0)
    }),
  )

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }

  const handleSelect = (item: DisplayItem) => {
    if (item.isDir) {
      toggleDir(item.path)
    } else {
      props.onSelect(item.path)
    }
  }

  const move = (delta: number) => {
    const items = displayItems()
    if (items.length === 0) return

    const next = Math.max(0, Math.min(items.length - 1, selectedIndex() + delta))
    setSelectedIndex(next)

    if (scrollRef) {
      const height = scrollRef.height || 10
      const y = scrollRef.y || 0
      if (next < y) scrollRef.scrollTo(next)
      else if (next >= y + height) scrollRef.scrollTo(next - height + 1)
    }
  }

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      dialog.clear()
      return
    }

    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      move(-1)
      return
    }

    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      move(1)
      return
    }

    if (evt.name === "return") {
      const item = displayItems()[selectedIndex()]
      if (item) handleSelect(item)
      return
    }

    if (evt.name === "right" || evt.name === "tab") {
      const item = displayItems()[selectedIndex()]
      if (item?.isDir && !item.expanded) toggleDir(item.path)
      return
    }

    if (evt.name === "left") {
      const item = displayItems()[selectedIndex()]
      if (item?.isDir && item.expanded) toggleDir(item.path)
      return
    }

    if (evt.name === "c" && !search().trim()) {
      setViewMode((m) => (m === "tree" ? "changed" : "tree"))
      return
    }

    if (evt.name === "pageup") {
      move(-10)
      return
    }

    if (evt.name === "pagedown") {
      move(10)
      return
    }
  })

  const fg = selectedForeground(theme)

  return (
    <box flexDirection="column" gap={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {viewMode() === "changed" ? "Changed Files" : "File Explorer"}
          </text>
          <text fg={theme.textMuted}>esc</text>
        </box>
        <box paddingTop={1}>
          <input
            ref={(r) => (inputRef = r)}
            placeholder="Search files..."
            onInput={setSearch}
            focusedBackgroundColor={theme.backgroundPanel}
            cursorColor={theme.primary}
            focusedTextColor={theme.text}
          />
        </box>
      </box>

      <Show
        when={!loading()}
        fallback={
          <box paddingLeft={4} paddingTop={1}>
            <text fg={theme.textMuted}>Loading files...</text>
          </box>
        }
      >
        <Show
          when={displayItems().length > 0}
          fallback={
            <box paddingLeft={4} paddingTop={1}>
              <text fg={theme.textMuted}>{viewMode() === "changed" ? "No changed files" : "No files found"}</text>
            </box>
          }
        >
          <scrollbox ref={(r) => (scrollRef = r)} maxHeight={18} paddingLeft={1} paddingRight={1}>
            <For each={displayItems()}>
              {(item, idx) => {
                const active = () => idx() === selectedIndex()
                const isCurrent = () => item.path === props.currentFile
                const isEditing = () => isActiveEdit(item.path)
                const indent = search().trim() || viewMode() === "changed" ? 0 : item.depth
                const hasGutter = isCurrent() || (isEditing() && !active())

                return (
                  <box
                    flexDirection="row"
                    paddingLeft={hasGutter ? indent * 2 + 1 : indent * 2 + 3}
                    paddingRight={3}
                    backgroundColor={active() ? (isEditing() ? theme.warning : theme.primary) : undefined}
                    onMouseUp={() => handleSelect(item)}
                    onMouseOver={() => setSelectedIndex(idx())}
                  >
                    <Show when={isCurrent()}>
                      <text fg={active() ? fg : theme.primary}>● </text>
                    </Show>
                    <Show when={!isCurrent() && isEditing() && !active()}>
                      <text fg={theme.warning}>● </text>
                    </Show>
                    <Show when={item.isDir}>
                      <text fg={active() ? fg : theme.textMuted}>{item.expanded ? "▼ " : "▶ "}</text>
                    </Show>
                    <text
                      fg={active() ? fg : item.isDir ? theme.accent : isEditing() ? theme.warning : theme.text}
                      attributes={active() || item.isDir ? TextAttributes.BOLD : undefined}
                      flexGrow={1}
                    >
                      {viewMode() === "changed" || search().trim() ? item.path : item.name}
                      {item.isDir ? "/" : ""}
                    </text>
                    <Show when={item.additions !== undefined}>
                      <box flexDirection="row" gap={1} flexShrink={0}>
                        <Show when={item.additions! > 0}>
                          <text fg={active() ? fg : theme.success}>+{item.additions}</text>
                        </Show>
                        <Show when={item.deletions! > 0}>
                          <text fg={active() ? fg : theme.error}>-{item.deletions}</text>
                        </Show>
                      </box>
                    </Show>
                  </box>
                )
              }}
            </For>
          </scrollbox>
        </Show>
      </Show>

      <box paddingLeft={4} paddingRight={4} paddingTop={1} flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.text }}>↵</span> select <span style={{ fg: theme.text }}>↑↓</span> nav
          <Show when={viewMode() === "tree" && !search().trim()}>
            {" "}
            <span style={{ fg: theme.text }}>→</span> expand
          </Show>
        </text>
        <Show when={changedFiles().length > 0}>
          <box flexDirection="row" onMouseUp={() => setViewMode((m) => (m === "tree" ? "changed" : "tree"))}>
            <text fg={viewMode() === "changed" ? theme.accent : theme.textMuted}>
              <span style={{ fg: theme.text }}>c</span> Changed ({changedFiles().length})
            </text>
          </box>
        </Show>
      </box>
    </box>
  )
}
