# 0157: A file the agent sent is found by its id in the log, and read where it is

- **Status:** Accepted (2026-11-20)
- **Date:** 2026-11-20
- **Trail:** The operator asked on 2026-11-20 for Claude Code's `SendUserFile` to show in Collie as it
  shows on claude.ai, pictures and then videos and sounds as well. Two roads were put to him and he
  chose: read the file where the agent left it, not a copy Collie keeps; a download card for any other
  file; a cap of 100 MB. Files: `bridge/journal/sent-files.ts`, `bridge/journal/claude.ts`,
  `bridge/server.ts` (`PANE_SENT_FILE_ROUTE`, `paneSentFile`, the page CSP), `bridge/crew/forward.ts`,
  `web/src/components/sent-files.tsx`, `web/src/lib/sent-file-cache.ts`, `web/src/lib/api.ts`
  (`sentFilePath`, `fetchSentFile`)

## Context

`SendUserFile` puts a file in front of the person: a screenshot, a contact sheet, a screen recording, a
report. On claude.ai the file shows in the conversation. In Collie the call was a tool card with a path
on it, and the file never reached the phone.

Claude Code records each call twice. The call's `input` has the paths and a `caption`. The row that
answers it has `toolUseResult.attachments`: per file a `path`, a `size`, a `media_type`, an `isImage`
flag and a `file_uuid`. Claude Code writes that record at the row level. An agent that prints the same
JSON as text puts it inside a string, where it is not a record.

The files are often in a scratchpad under `/tmp`, which a reboot clears.

## Decision

1. **The wire carries ids, never paths.** The Claude reader folds a `SentFiles` value onto the call's
   result: the caption, and per file the `file_uuid`, the base name, a kind (image, video, audio or
   file, from Claude Code's labels) and the size. The Chat draws the files in place of the call's card;
   History draws them under it.
2. **The bytes are at `GET /api/pane/<id>/sent-file/<file_uuid>`.** The pane id is a lookup in the
   snapshot and the log is found as the history read finds it. The id must have the `file_uuid` shape,
   and is then looked up in the newest `MAX_TRANSCRIPT_BYTES` of that log, in a row's own
   `toolUseResult.attachments`. The client never supplies a value that becomes a path: the same posture
   as `/api/fonts/<name>`, and not a fifth entry in the list of client values that become paths.
3. **The file is read where it is.** Collie keeps no copy. A file that is gone answers 404 and the phone
   says that it is no longer on the machine. Links are followed; only a regular file is read, at most
   100 MB (`SENT_FILE_MAX_BYTES`).
4. **The type comes off the bytes.** Pictures as in the Files view, and MP4, QuickTime, WebM, Ogg, FLAC,
   WAV and MP3 by their magic bytes. Those are served `inline` under their type; anything else as
   `application/octet-stream` and `attachment`. Every answer is `private, no-store`, with
   `default-src 'none'; sandbox` and `nosniff`.
5. **The phone fetches with the pairing token and plays an object URL.** A picture loads at once. A
   video, a sound and a download load on a tap. The page CSP gains `media-src 'self' blob:` for the
   players. Fetched files are kept for the page up to 256 MB, oldest first out.
6. **A sent file is a forwarded read** across the crew link (`pane/<id>/sent-file/<id>`), because the
   file is on the machine whose log named it. Additive-optional: an older member answers 404.

## Consequences

- The bridge now reads a file at a path the agent chose. This gives no new reach. The paired device can
  already type into the agent's terminal, and `SendUserFile` already uploaded the same file to claude.ai.
  The route serves only the files the log recorded as sent, to a paired device, never cached.
- A file the agent deletes, or a reboot clears, is gone from the conversation too. If that becomes a
  real complaint, the other road is a copy under the state folder with a size budget, made when the
  bridge first reads the row.
- A video is held whole in the phone's memory, because a `<video src>` cannot carry the token. A token
  in a cookie or in the URL would let it stream; neither exists today, and adding one is its own record.
- A Claude Code that renames the tool or changes the attachment record shows the call as a plain card
  again. `bridge/journal/sent-files.test.ts` pins the shape read from real logs.
