# image-peek

image-peek shows the pictures in a Claude Code session: the ones in the
prompt being typed, and the ones in prompts already sent.

## Pictures

**Picture**:
One image the session holds, known by the number of its placeholder.
_Avoid_: image entry, attachment

**Placeholder**:
The `[Image #N]` text the engine puts in a prompt where a picture goes.
_Avoid_: tag, marker

**Source**:
Where a picture's bytes came from: the clipboard, a file dropped or pasted, or the transcript row of a prompt.
_Avoid_: origin, kind

**Stage**:
Where a picture is in its life: draft, submitted, stored or history.
_Avoid_: status, state

**Draft**:
The stage of a picture in the prompt still being typed.
_Avoid_: pending, unsent

**Submitted**:
The stage of a picture whose prompt was sent, before the bytes the engine stored with it are in.
_Avoid_: tagged

**Stored**:
The stage of a picture whose bytes are the ones the engine stored with a prompt sent this session: what the model saw.
_Avoid_: sent (as a stage)

**History**:
The stage of a picture read back from the transcript of a resumed session.
_Avoid_: old, resumed

**Sent**:
Any stage past draft: submitted, stored or history.
_Avoid_: not a draft

## Lifetime

**Generation**:
The span between two clean slates (a session end, `/clear`, `/resume`, `/peek clear`); every listed picture belongs to the current one.
_Avoid_: epoch, session

**Work**:
One job that makes files for pictures, within the generation it began in; once a newer generation begins, it stops before changing anything.
_Avoid_: task, job

**Session folder**:
The folder that holds a session's picture files.
_Avoid_: cache dir, temp dir

**Intake**:
How pictures come in: draft intake behind the prompt's placeholders, and stored intake from a prompt's stored row.
_Avoid_: capture (for both), import

## Showing

**Band**:
The strip right above the prompt that shows the draft's pictures.
_Avoid_: bar, header

**Chip**:
A `▣ Image N` label for one picture, in the band or under a sent prompt; hovering or pressing it shows the picture.
_Avoid_: badge, pill

**Hover card**:
The bigger view of a picture that shows while its chip is hovered.
_Avoid_: preview popup, tooltip

**Pane**:
The Images panel beside the chat: the session's pictures listed, or one big.
_Avoid_: sidebar, viewer

**Cells**:
A picture drawn as coloured half-block characters, for terminals that cannot draw images.
_Avoid_: raster, ASCII art

**Thumb**:
A copy of a picture at most 800 px wide, drawn as an image in the hover card and the pane.
_Avoid_: preview

**Small**:
A copy of a picture at most 400 px wide, drawn as an inline thumbnail under a sent prompt, and the copy every view's cells are made from.
_Avoid_: mini, icon
