# image-peek

When you paste an image into Claude Code it shows up as `[Image #1]`. This mod lets you see it.

- **While you type:** a band right above the prompt shows a thumbnail for each `[Image #N]` in your draft (click one to see it big). `/peek` opens the **Images** pane beside the chat.
- **On sent messages:** each image gets a `▣ Image N` chip under your message. In the fullscreen layout, hover over it to see the image and click to open it in the pane. On the main screen, small thumbnails are drawn inline instead.
- **Old chats:** when you resume a session, its images are read back from the conversation, so the chips work there too.
- **`/peek`** opens the pane, **`/peek N`** shows image N big (in your system viewer when drawing is `off`), **`/peek open N`** opens it in your system viewer (Preview on macOS), **`/peek clear`** empties the list, **`/peek debug`** turns the mod's probe lines in the transcript on or off.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install image-peek --marketplace its-magdy/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope (user is first; Enter takes it).

From a shell:

```
claude plugin install image-peek --marketplace its-magdy/claude-code-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `its-magdy/claude-code-mods`, then Add plugin.

Turn it off or on again with `claude plugin disable image-peek` / `claude plugin enable image-peek`.

## How it gets the picture

1. **As you paste:** when an `[Image #N]` appears in the prompt, the mod saves the clipboard image (macOS `osascript`, Linux `wl-paste`/`xclip`, Windows `powershell`). If the paste was a file path (a dropped file, or the screenshot thumbnail), it copies that file at once instead, because macOS deletes the thumbnail's temporary file soon after.
2. **When you send:** the image bytes stored with your prompt replace that guess, so what you see is exactly what Claude got.
3. **When you resume:** images in the conversation are written back out to files.

The files live in a folder only you can read (macOS: your per-user temp folder; Linux: `$XDG_RUNTIME_DIR` or `~/.cache`; Windows: `%LOCALAPPDATA%`), under `claude-image-peek/<session>/`, and are removed when the session ends or you `/clear` or `/resume` (on Windows, a session that exits is cleaned up by a later session once its folder is a day old).

## Terminals

| Terminal | What you see |
| --- | --- |
| Ghostty, cmux, kitty | Real pixels (the terminal reads the PNG from disk) |
| iTerm2 3.5+ (fullscreen layout; blocks inline on the main screen), tmux with `allow-passthrough on` and `focus-events on` | Real pixels (PNG bytes) |
| VS Code, Windows Terminal, GNOME Terminal, Konsole, Terminal.app, … | A colored half-block preview; `/peek open N` for full quality |

## Settings

Both are in `/config`:

| Setting | Values | Default |
| --- | --- | --- |
| **How to draw images** | `auto` picks by terminal (table above); `file`, `bytes`, `blocks` or `off` (labels only) | `auto` |
| **Open the pane when you paste an image** | Opens the Images pane (fullscreen layout only) the first time an image lands in the prompt | off |

## Needs

- macOS: nothing extra (`osascript` and `sips` are built in).
- Linux: `wl-clipboard` (Wayland) or `xclip` (X11) to read the clipboard; ImageMagick for thumbnails and the half-block preview.
- Windows / WSL: Windows PowerShell 5.1 (`powershell.exe`).

## Limits

- Claude Code doesn't hand a normal mod the pasted image before you send, so the preview shown while typing is the mod's own copy from the clipboard. If the clipboard changed in between (or Claude Code dropped the paste), it can be wrong until you send.
- Over SSH there is no local clipboard: images show once sent.
- Hovering needs the fullscreen layout, where Claude Code tracks the mouse.
- The hover preview gets the rows left above the prompt. When there are fewer than 6 (a short window, a long draft), it shows "Image N · click to open" instead of a tiny picture.
- The Images pane takes the keyboard when it opens only if the prompt is empty. With a draft in the prompt, click inside the pane before using Esc, `b`, `o` or `c` there.

## Permissions and privacy

- It reads your clipboard only when an `[Image #N]` appears in the prompt, and copies a file only when a paste names one.
- On macOS, when the clipboard has no new image, it looks for a screenshot taken in the last two minutes in your screenshot folder (Desktop unless you changed it) and macOS's temporary screenshot folder. That needs Full Disk Access for your terminal; without it nothing is read.
- It runs these local commands, nothing else: `osascript`, `sips`, `open`, `defaults read com.apple.screencapture location` (macOS); `wl-paste` or `xclip`, ImageMagick (`magick`/`convert`), `xdg-open` (Linux); `powershell.exe`, `explorer.exe`, `wslpath` (Windows/WSL); and `uname`, `sh`, `cp`, `chmod`, `head`, `base64`, `rm` for its own folder.
- The pictures stay on your machine in a folder only you can read, deleted when the session ends (on Windows, and anything left over, after a day).
- It makes no network requests.
