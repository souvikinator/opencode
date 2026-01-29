import type { Plugin } from "@opencode-ai/plugin"

let autoAcceptEdits = false

export const TogglePermissionsPlugin: Plugin = async ({ client }) => {
  return {
    "permission.ask": async (input, output) => {
      // Auto-allow edit permissions if toggled on
      if (input.type === "edit" && autoAcceptEdits) {
        output.status = "allow"
      }
    },

    "tui.command.execute": async (event) => {
      // Handle the /toggle-edits command via TUI events
      if (event.properties.command === "toggle-edits") {
        autoAcceptEdits = !autoAcceptEdits
        const message = `Auto-accept edits: ${autoAcceptEdits ? "✅ ON" : "❌ OFF"}`
        await client.tui.showToast({
          body: { message, variant: autoAcceptEdits ? "success" : "warning" },
        })
      }
    },
  }
}
