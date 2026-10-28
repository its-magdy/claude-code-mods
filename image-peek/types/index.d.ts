/** Where a picture came from. */
export type PeekSource =
  /** Grabbed from the clipboard as the placeholder appeared in the draft. */
  | 'clipboard'
  /** Copied from a file path that was dropped or pasted into the draft. */
  | 'file'
  /** The bytes the engine stored with a sent prompt: what the model saw. */
  | 'sent'
  /** Read back from the transcript of a resumed session. */
  | 'history'

export type PeekImage = {
  /** Unique within the session. */
  id: string
  /** The N of "[Image #N]". */
  n: number
  /** The picture as a PNG on disk. */
  path: string
  /** A PNG of 800 px at most, for the pane; `path` when none was made. */
  thumb: string
  /** A PNG of 400 px at most, for hover cards and inline thumbnails. */
  small: string
  /** The thumbnail's pixel size, 0 when unknown. */
  width: number
  height: number
  source: PeekSource
  /** The transcript row of the prompt that carried it; absent in the draft. */
  messageId?: string
  /** That prompt's text, to find its row when the row id is not known. */
  promptText?: string
  addedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'image-peek': {
      images: Shaped<PeekImage[]>
      /** The image the pane shows big, by id; null shows the list. */
      selected: string | null
      /** Probe lines go to the transcript instead of the debug log. */
      isDebug: boolean
    }
  }
}
