// ── A FILE THE AGENT SENT TO THE PERSON (Claude Code's SendUserFile) ─────────────────────────────
//
// Claude Code's `SendUserFile` tool puts a file in front of the person: a picture, a recording, a
// document. On claude.ai the file shows in the conversation. In Collie it showed only as a tool card
// with a path on it. This module lets the phone show the file itself (ADR 0175).
//
// WHAT THE LOG HOLDS. The call's `input` has the paths and an optional `caption`. The row that
// answers it carries `toolUseResult.attachments`: one record per file, with the `path`, the `size`,
// a `media_type`, an `isImage` flag and a `file_uuid`. Claude Code writes that record itself, at the
// row level, so the agent cannot forge one by printing text: a string in a message is a string.
//
// THE PATH NEVER LEAVES THE BRIDGE. The wire carries the `file_uuid`, a base name, a kind and a size.
// The phone asks `/api/pane/<id>/sent-file/<file_uuid>`, and the bridge reads the pane's own log to
// find the record with that id ({@link findSentFile}). The client supplies an id that is looked up,
// never a value that becomes a path: the same posture as `/api/fonts/<name>`.
//
// THE BYTES ARE READ WHERE THEY ARE. The bridge keeps no copy (the operator's choice, 2026-11-20):
// a file the agent removed, or a scratchpad a reboot cleared, answers 404, and the phone says so.

import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";

import { sniffImageType } from "../files-view.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { loadTail } from "./files.ts";
import type { SentFile, SentFileKind, SentFiles } from "./types.ts";

/** The tool's name in Claude Code's log. */
export const SEND_USER_FILE_TOOL = "SendUserFile";

/**
 * The most bytes one sent file may have. A video is the large case, and the phone holds the whole
 * file in memory to play it (the pairing token cannot ride on a `<video src>`), so the cap is a
 * phone's budget, not a disk's (the operator's choice, 2026-11-20).
 */
export const SENT_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** The longest caption kept. A caption is one line of context, not a document. */
export const MAX_CAPTION_CHARS = 2000;

/** Claude Code's `file_uuid`: a lowercase or uppercase RFC 4122 shape, and nothing else. */
const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` has the shape of a `file_uuid`. Checked before any log is opened. */
export function isSentFileId(id: string): boolean {
  return FILE_ID_RE.test(id);
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** One attachment record as the bridge keeps it: what the wire gets, plus the path. */
export interface SentFileRecord extends SentFile {
  path: string;
}

/**
 * The kind the phone draws, from Claude Code's own labels. `isImage` wins, then the media type's
 * top level. Anything else is a download. The label decides the card, never the served type.
 */
function kindOf(mediaType: string | undefined, isImage: boolean): SentFileKind {
  if (isImage || mediaType?.startsWith("image/") === true) return "image";
  if (mediaType?.startsWith("video/") === true) return "video";
  if (mediaType?.startsWith("audio/") === true) return "audio";
  return "file";
}

/** One attachment record, checked: a `file_uuid` of the right shape and an absolute path. */
function recordOf(raw: JsonValue): SentFileRecord | null {
  const a = asObject(raw);
  if (a === null) return null;
  const id = a.file_uuid;
  const path = a.path;
  if (typeof id !== "string" || !isSentFileId(id)) return null;
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) return null;
  const mediaType = typeof a.media_type === "string" && a.media_type !== "" ? a.media_type : undefined;
  const record: SentFileRecord = { id, name: basename(path), kind: kindOf(mediaType, a.isImage === true), path };
  if (mediaType !== undefined) record.mediaType = mediaType;
  if (typeof a.size === "number" && Number.isSafeInteger(a.size) && a.size >= 0) record.size = a.size;
  return record;
}

/** Every checked attachment record of one `toolUseResult`, in the order Claude Code wrote them. */
export function sentFileRecords(toolUseResult: JsonValue | undefined): SentFileRecord[] {
  const attachments = asObject(toolUseResult)?.attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.map(recordOf).filter((r): r is SentFileRecord => r !== null);
}

/**
 * What a `SendUserFile` call sent, for the wire: the caption and the files, both from the answering
 * row's `toolUseResult` (Claude Code copies the call's caption there). `null` when the row recorded
 * no file (the call failed, or a Claude Code that wrote no attachments). The path is dropped here.
 */
export function sentFilesOf(toolUseResult: JsonValue | undefined): SentFiles | null {
  const files = sentFileRecords(toolUseResult).map(({ path: _path, ...file }) => file);
  if (files.length === 0) return null;
  const sent: SentFiles = { files };
  const caption = asObject(toolUseResult)?.caption;
  if (typeof caption === "string" && caption.trim() !== "") sent.caption = caption.slice(0, MAX_CAPTION_CHARS);
  return sent;
}

/**
 * The record of file `id` in a log's text, or `null` when no row of the log recorded it.
 *
 * Only a line that holds the id is parsed, so a long log costs one substring search. The record must
 * sit in a row's own `toolUseResult.attachments`: the id quoted in a message, or in a tool's output,
 * is inside a string there and is never taken. The newest row wins when two name the same id.
 */
export function findSentFile(logText: string, id: string): SentFileRecord | null {
  if (!isSentFileId(id)) return null;
  let at = logText.lastIndexOf(id);
  while (at !== -1) {
    const start = logText.lastIndexOf("\n", at) + 1;
    const end = logText.indexOf("\n", at);
    const line = logText.slice(start, end === -1 ? undefined : end);
    let row: JsonValue | undefined;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction: a string, number, boolean or
      // null, or an array or object of those. Every field below is read through `asObject`.
      row = JSON.parse(line) as JsonValue;
    } catch {
      row = undefined;
    }
    const hit = sentFileRecords(asObject(row)?.toolUseResult).find((r) => r.id === id);
    if (hit !== undefined) return hit;
    at = start === 0 ? -1 : logText.lastIndexOf(id, start - 1);
  }
  return null;
}

/** How many looked-up records {@link sentFileInLog} keeps. A phone shows a few at a time. */
const MEMO_MAX = 256;
const memo = new Map<string, SentFileRecord>();

/**
 * The record of file `id` in the log at `logPath`, or `null`. It reads the same tail the history
 * read parses (`MAX_TRANSCRIPT_BYTES`), so a file the phone was shown is a file this can find. A
 * hit is kept: a `file_uuid` names one file for good, and a second tap costs no read of the log.
 */
export async function sentFileInLog(logPath: string, id: string): Promise<SentFileRecord | null> {
  if (!isSentFileId(id)) return null;
  const key = `${logPath}\0${id}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let found: SentFileRecord | null;
  try {
    found = findSentFile((await loadTail(logPath)).text, id);
  } catch {
    return null;
  }
  if (found === null) return null;
  memo.set(key, found);
  if (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  return found;
}

/** The leading bytes {@link sniffMediaType} reads. */
export const MEDIA_SNIFF_BYTES = 64;

function ascii(head: Uint8Array, offset: number, text: string): boolean {
  if (head.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (head[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

/**
 * The type of a picture, a recording or a sound, read off its leading bytes and nothing else. The
 * extension and Claude Code's `media_type` are labels; a type taken from them would hand the browser
 * bytes under a label they do not match. `null` is every other file, and the route serves it as a
 * download (`application/octet-stream`, `attachment`).
 *
 * - The five pictures of the Files view (`sniffImageType`, ADR 0090).
 * - An ISO-BMFF `ftyp` box at 4: `qt  ` is QuickTime, `M4A ` is audio, anything else is MP4.
 * - EBML (`1A 45 DF A3`): WebM or Matroska, served as WebM.
 * - `OggS`: Ogg. `fLaC`: FLAC. `RIFF` with `WAVE` at 8: WAV.
 * - MP3: an `ID3` tag, or an MPEG audio frame sync (`FF` then the top three bits of the next byte).
 */
export function sniffMediaType(head: Uint8Array): string | null {
  const image = sniffImageType(head);
  if (image !== null) return image;
  if (ascii(head, 4, "ftyp")) {
    if (ascii(head, 8, "qt  ")) return "video/quicktime";
    if (ascii(head, 8, "M4A ")) return "audio/mp4";
    return "video/mp4";
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  if (ascii(head, 0, "OggS")) return "audio/ogg";
  if (ascii(head, 0, "fLaC")) return "audio/flac";
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WAVE")) return "audio/wav";
  if (ascii(head, 0, "ID3")) return "audio/mpeg";
  if (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  return null;
}

/** What a sent-file read comes to. */
export type SentFileRead =
  | { kind: "gone" }
  | { kind: "too-large"; size: number }
  | { kind: "file"; real: string; size: number; name: string; type: string | null };

/**
 * The file a record names, checked: the real path (links resolved), a regular file, at most
 * {@link SENT_FILE_MAX_BYTES}, and its type off its first bytes. A file that is gone, or is now a
 * folder or a device, is `gone`.
 */
export async function readSentFile(record: SentFileRecord): Promise<SentFileRead> {
  let real: string;
  try {
    real = await realpath(record.path);
    const st = await lstat(real);
    if (!st.isFile()) return { kind: "gone" };
    if (st.size > SENT_FILE_MAX_BYTES) return { kind: "too-large", size: st.size };
    const head = new Uint8Array(await Bun.file(real).slice(0, MEDIA_SNIFF_BYTES).arrayBuffer());
    return { kind: "file", real, size: st.size, name: record.name, type: sniffMediaType(head) };
  } catch {
    return { kind: "gone" };
  }
}
