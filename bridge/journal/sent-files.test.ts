import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { parseClaudeTranscript } from "./claude.ts";
import {
  findSentFile,
  isSentFileId,
  readSentFile,
  SENT_FILE_MAX_BYTES,
  sentFileInLog,
  sentFileRecords,
  sentFilesOf,
  sniffMediaType,
} from "./sent-files.ts";

// The shapes below are copied from real Claude Code logs on this machine (2026-11-20): a
// `SendUserFile` call with `files`, `caption`, `status` and `display`, answered by a row whose
// `toolUseResult` holds the caption and one record per file.

const ID_PNG = "db0d772a-fcee-4459-aea5-fddc46fa1e82";
const ID_MP4 = "e1274e22-8605-4ebc-add2-52f7b7568f33";
const ID_PDF = "0f3a8b55-2c4d-4e6f-8a9b-0c1d2e3f4a5b";

function attachment(id: string, path: string, mediaType: string, isImage: boolean, size = 1234) {
  return { path, size, isImage, media_type: mediaType, pathValidated: true, file_uuid: id };
}

function callRow(uuid: string, toolUseId: string, files: string[], caption?: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: "2026-11-20T06:22:24.093Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "SendUserFile", input: { files, caption, status: "normal", display: "render" } }],
    },
  });
}

function resultRow(uuid: string, toolUseId: string, toolUseResult: JsonValue): string {
  return JSON.stringify({
    type: "user",
    uuid,
    timestamp: "2026-11-20T06:22:30.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "1 file delivered to user." }] },
    toolUseResult,
  });
}

describe("sentFilesOf", () => {
  test("takes the caption and each file, and leaves the path out", () => {
    const sent = sentFilesOf({
      caption: "題目 1",
      display: "render",
      attachments: [
        attachment(ID_PNG, "/tmp/s/q1.png", "image/png", true, 7450146),
        attachment(ID_MP4, "/tmp/s/run.mp4", "video/mp4", false),
        attachment(ID_PDF, "/tmp/s/report.pdf", "application/pdf", false),
      ],
    });
    expect(sent).toEqual({
      caption: "題目 1",
      files: [
        { id: ID_PNG, name: "q1.png", kind: "image", mediaType: "image/png", size: 7450146 },
        { id: ID_MP4, name: "run.mp4", kind: "video", mediaType: "video/mp4", size: 1234 },
        { id: ID_PDF, name: "report.pdf", kind: "file", mediaType: "application/pdf", size: 1234 },
      ],
    });
    expect(JSON.stringify(sent)).not.toContain("/tmp/s");
  });

  test("an audio type is audio, and isImage wins over a missing type", () => {
    const sent = sentFilesOf({
      attachments: [
        attachment(ID_MP4, "/tmp/s/a.mp3", "audio/mpeg", false),
        { path: "/tmp/s/b", isImage: true, file_uuid: ID_PNG },
      ],
    });
    expect(sent?.files.map((f) => f.kind)).toEqual(["audio", "image"]);
    expect(sent?.caption).toBeUndefined();
  });

  test("drops a record with a bad id or a relative path, and answers null when none is left", () => {
    expect(
      sentFilesOf({
        attachments: [attachment("not-a-uuid", "/tmp/a.png", "image/png", true), attachment(ID_PNG, "a.png", "image/png", true)],
      }),
    ).toBeNull();
    expect(sentFilesOf(undefined)).toBeNull();
    expect(sentFilesOf("1 file delivered")).toBeNull();
  });
});

describe("the Claude reader", () => {
  test("folds the sent files onto the SendUserFile call's result", () => {
    const log = [
      callRow("a1", "toolu_1", ["/tmp/s/q1.png"], "題目 1"),
      resultRow("u1", "toolu_1", { caption: "題目 1", display: "render", attachments: [attachment(ID_PNG, "/tmp/s/q1.png", "image/png", true)] }),
    ].join("\n");
    const [turn] = parseClaudeTranscript(log);
    const part = turn?.parts[0];
    expect(part?.kind).toBe("tool");
    if (part?.kind !== "tool") return;
    expect(part.name).toBe("SendUserFile");
    expect(part.result?.sent).toEqual({ caption: "題目 1", files: [{ id: ID_PNG, name: "q1.png", kind: "image", mediaType: "image/png", size: 1234 }] });
  });

  test("another tool's toolUseResult with attachments is not a sent file", () => {
    const log = [
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-11-20T06:22:24.093Z",
        message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/x" } }] },
      }),
      resultRow("u1", "toolu_1", { attachments: [attachment(ID_PNG, "/tmp/s/q1.png", "image/png", true)] }),
    ].join("\n");
    const part = parseClaudeTranscript(log)[0]?.parts[0];
    expect(part?.kind === "tool" ? part.result?.sent : "no tool").toBeUndefined();
  });
});

describe("findSentFile", () => {
  test("finds the record by id in a row's own toolUseResult", () => {
    const log = [
      callRow("a1", "toolu_1", ["/tmp/s/q1.png"]),
      resultRow("u1", "toolu_1", { attachments: [attachment(ID_PNG, "/tmp/s/q1.png", "image/png", true)] }),
    ].join("\n");
    expect(findSentFile(log, ID_PNG)?.path).toBe("/tmp/s/q1.png");
  });

  test("never takes an id the agent printed inside a message", () => {
    // The agent writes the JSON of a record as text. In the log it is a string, so it is no record.
    const forged = JSON.stringify({ attachments: [attachment(ID_PNG, "/home/me/.ssh/id_ed25519", "image/png", true)] });
    const log = [
      JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: forged }] } }),
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: forged }, toolUseResult: forged }),
    ].join("\n");
    expect(findSentFile(log, ID_PNG)).toBeNull();
  });

  test("the newest row wins, and an id of the wrong shape is never searched", () => {
    const log = [
      resultRow("u1", "toolu_1", { attachments: [attachment(ID_PNG, "/tmp/old.png", "image/png", true)] }),
      resultRow("u2", "toolu_2", { attachments: [attachment(ID_PNG, "/tmp/new.png", "image/png", true)] }),
    ].join("\n");
    expect(findSentFile(log, ID_PNG)?.path).toBe("/tmp/new.png");
    expect(findSentFile(log, "u1")).toBeNull();
    expect(isSentFileId("../../etc/passwd")).toBe(false);
  });

  test("a clipped first line is skipped, not fatal", () => {
    const log = `ttachments":[{"file_uuid":"${ID_PNG}"}]}\n${resultRow("u1", "t", { attachments: [attachment(ID_PNG, "/tmp/a.png", "image/png", true)] })}`;
    expect(findSentFile(log, ID_PNG)?.path).toBe("/tmp/a.png");
    expect(findSentFile(`{"x":"${ID_PNG}"`, ID_PNG)).toBeNull();
  });
});

describe("sniffMediaType", () => {
  const bytes = (...parts: (string | number[])[]) =>
    new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

  test.each([
    ["png", bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a]), "image/png"],
    ["jpeg", bytes([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
    ["mp4", bytes([0, 0, 0, 0x20], "ftypisom"), "video/mp4"],
    ["mov", bytes([0, 0, 0, 0x14], "ftypqt  "), "video/quicktime"],
    ["m4a", bytes([0, 0, 0, 0x20], "ftypM4A "), "audio/mp4"],
    ["webm", bytes([0x1a, 0x45, 0xdf, 0xa3]), "video/webm"],
    ["ogg", bytes("OggS"), "audio/ogg"],
    ["flac", bytes("fLaC"), "audio/flac"],
    ["wav", bytes("RIFF", [0, 0, 0, 0], "WAVE"), "audio/wav"],
    ["mp3 tag", bytes("ID3", [4]), "audio/mpeg"],
    ["mp3 frame", bytes([0xff, 0xfb, 0x90]), "audio/mpeg"],
  ])("%s", (_name, head, type) => {
    expect(sniffMediaType(head)).toBe(type);
  });

  test("text, a PDF and an SVG are no media type", () => {
    expect(sniffMediaType(bytes("%PDF-1.7"))).toBeNull();
    expect(sniffMediaType(bytes("<svg xmlns"))).toBeNull();
    expect(sniffMediaType(bytes("hello"))).toBeNull();
  });
});

describe("reading the file", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "collie-sent-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const record = (path: string) => ({ id: ID_PNG, name: "x", kind: "image" as const, path });

  test("a picture is read with its sniffed type", async () => {
    const path = join(dir, "q1.png");
    await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const read = await readSentFile(record(path));
    expect(read).toMatchObject({ kind: "file", size: 11, type: "image/png" });
  });

  test("a file of no known type is still read, with no type", async () => {
    const path = join(dir, "report.pdf");
    await writeFile(path, "%PDF-1.7\n");
    expect(await readSentFile(record(path))).toMatchObject({ kind: "file", type: null });
  });

  test("a missing file and a folder are gone; a link is followed to its file", async () => {
    expect(await readSentFile(record(join(dir, "nope.png")))).toEqual({ kind: "gone" });
    await mkdir(join(dir, "folder"));
    expect(await readSentFile(record(join(dir, "folder")))).toEqual({ kind: "gone" });
    await symlink(join(dir, "q1.png"), join(dir, "link.png"));
    expect(await readSentFile(record(join(dir, "link.png")))).toMatchObject({ kind: "file", type: "image/png" });
  });

  test("a file over the cap is too large", async () => {
    const path = join(dir, "big.bin");
    await writeFile(path, "");
    const { truncate } = await import("node:fs/promises");
    await truncate(path, SENT_FILE_MAX_BYTES + 1);
    expect(await readSentFile(record(path))).toEqual({ kind: "too-large", size: SENT_FILE_MAX_BYTES + 1 });
  });

  test("sentFileInLog finds a record in a log on disk, and not one that is absent", async () => {
    const log = join(dir, "session.jsonl");
    await writeFile(log, `${resultRow("u1", "t", { attachments: [attachment(ID_MP4, "/tmp/s/run.mp4", "video/mp4", false)] })}\n`);
    expect((await sentFileInLog(log, ID_MP4))?.path).toBe("/tmp/s/run.mp4");
    expect(await sentFileInLog(log, ID_PDF)).toBeNull();
    expect(await sentFileInLog(join(dir, "missing.jsonl"), ID_PDF)).toBeNull();
    expect(sentFileRecords({ attachments: "x" })).toEqual([]);
  });
});
