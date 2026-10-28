# Changelog

Each version matches `version` in `.claude-plugin/plugin.json` and is tagged
`image-peek-v<version>`.

## 0.1.2 — 2026-10-28

### Fixed

- The Images pane lists a picture you just sent under **Sent**. Until the
  sent prompt's bytes arrived, it showed under **In your prompt**.
- A resumed session reads back pictures of a prompt sent more than once,
  even when the copies differ only in Claude Code's hidden reminders.

### Docs

- README: a file dropped or pasted as a path shows once sent; Claude Code
  doesn't tell a mod which file it was. On macOS a recent screenshot may
  show until then, as a guess.

## 0.1.1 — 2026-10-28

### Changed

- The `/peek` command's description in the slash menu lists `/peek clear`.
- The plugin description says sent-message previews show on hover only in the
  fullscreen layout.

### Docs

- README: the draft band, `/peek debug` (a toggle), `/peek N` with drawing
  `off`, cleanup on `/clear` and `/resume`, the macOS screenshot copy, and a
  Settings table for both options.

## 0.1.0 — 2026-10-28

First release.

- A band above the prompt shows each `[Image #N]` in the draft.
- A `▣ Image N` chip under each sent message: a hover preview in the
  fullscreen layout, inline thumbnails on the main screen.
- The **Images** pane and `/peek`, `/peek N`, `/peek open N`, `/peek clear`,
  `/peek debug`.
- Images read back from resumed sessions.
- Drawing by terminal: PNG files (Ghostty, kitty), PNG bytes (iTerm2, tmux) or
  colored half-blocks, set with **How to draw images**.
- **Open the pane when you paste an image** setting.
