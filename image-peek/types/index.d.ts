/** Where a picture's bytes came from. */
export type PeekSource =
  /** Grabbed from the clipboard as the placeholder appeared in the draft. */
  | 'clipboard'
  /** Copied from a file path that was dropped or pasted into the draft. */
  | 'file'
  /** Written from the bytes a prompt's transcript row carried: what the model saw. */
  | 'transcript'

/** Where a picture is in its life; every stage but `draft` is sent. */
export type PeekStage =
  /** In the prompt being typed. */
  | 'draft'
  /** Its prompt was submitted (tagged with the prompt's text); the stored bytes are not in yet. */
  | 'submitted'
  /** The bytes stored with a prompt sent this session. */
  | 'stored'
  /** Read back from the transcript of a resumed session. */
  | 'history'

export type PeekImage = {
  /** Unique within the session. */
  id: string
  /** The N of "[Image #N]". */
  n: number
  /** The picture as a PNG on disk. */
  path: string
  /** A PNG of 800 px at most, drawn as an image in the hover card and the pane; `path` when none was made. */
  thumb: string
  /** A PNG of 400 px at most, drawn as an inline thumbnail and made into every view's cells; `thumb` when none was made. */
  small: string
  /** The thumbnail's pixel size, 0 when unknown. */
  width: number
  height: number
  source: PeekSource
  stage: PeekStage
  /** The transcript row of the prompt that carried it: known once `stored`. */
  messageId?: string
  /** That prompt's text, to find its row when the row id is not known: absent in the draft. */
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
