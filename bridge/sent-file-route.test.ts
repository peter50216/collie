import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.ts";
import { buildJournalRegistry } from "./journal/registry.ts";
import { declareCapabilities } from "./mux/capabilities.ts";
import { muxGone, muxOk } from "./mux/types.ts";
import { paneSentFile } from "./server.ts";
import type { StateEngine } from "./state-engine.ts";
import type { AgentView } from "./types.ts";

// `GET /api/pane/<id>/sent-file/<file id>` (ADR 0175) over the shipped registry, Claude reader and
// route function, against a Claude log on disk. Only the multiplexer and the engine are stand-ins.

const SESSION = "5cfa7946-2b17-4f60-b3fd-5959e92faeea";
const ID_PNG = "db0d772a-fcee-4459-aea5-fddc46fa1e82";
const ID_PDF = "e1274e22-8605-4ebc-add2-52f7b7568f33";
const ID_GONE = "0f3a8b55-2c4d-4e6f-8a9b-0c1d2e3f4a5b";
const ID_ELSEWHERE = "11111111-2222-4333-8444-555555555555";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

let base = "";

function resultRow(uuid: string, toolUseId: string, attachments: Record<string, string | number | boolean>[]): string {
  return JSON.stringify({
    type: "user",
    uuid,
    sessionId: SESSION,
    timestamp: "2026-11-20T06:22:30.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "delivered" }] },
    toolUseResult: { attachments },
  });
}

function world() {
  const cfg = loadConfig({ HOME: base, COLLIE_STATE_DIR: join(base, "state"), COLLIE_HOST: "127.0.0.1" });
  const journals = buildJournalRegistry({
    agy: [], claude: [join(base, "projects")], codex: [], pi: [], opencode: [], grok: [], hermes: [], muse: [], openclaw: [], kiro: [], "dsh-tui": [], mcode: [],
  });
  const agents: AgentView[] = [
    {
      paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "one", workspaceNumber: 1, tabId: "w1:t1",
      agent: "claude", status: "idle", cwd: base, focused: false, agentSession: { kind: "id", value: SESSION },
    },
  ];
  const partial: Partial<StateEngine> = {
    current: () => ({ agents, shellPanes: [], workspaces: [], tabs: [], bridge: "connected" }),
  };
  // SAFETY: the route reads only current(); no engine polling or real multiplexer is started.
  const engine = partial as StateEngine;
  const mux = {
    capabilities: declareCapabilities({ supports: ["paneGrid", "agentSessionRef"], topologyLatency: { kind: "push" } }),
    readGrid: async () => muxGone("not needed"),
    foregroundProcesses: async () => muxOk([]),
  };
  return (paneId: string, fileId: string) => paneSentFile(cfg, journals, engine, mux, paneId, fileId);
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "collie-sent-route-"));
  const project = join(base, "projects", "-work");
  await mkdir(project, { recursive: true });
  const png = join(base, "q1.png");
  const pdf = join(base, "report.pdf");
  await writeFile(png, PNG);
  await writeFile(pdf, "%PDF-1.7\n");
  const log = [
    resultRow("u1", "t1", [{ path: png, size: PNG.length, isImage: true, media_type: "image/png", file_uuid: ID_PNG }]),
    resultRow("u2", "t2", [{ path: pdf, size: 9, isImage: false, media_type: "application/pdf", file_uuid: ID_PDF }]),
    resultRow("u3", "t3", [{ path: join(base, "removed.png"), isImage: true, media_type: "image/png", file_uuid: ID_GONE }]),
  ].join("\n");
  await writeFile(join(project, `${SESSION}.jsonl`), `${log}\n`);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("paneSentFile", () => {
  test("a picture comes back inline, under the type its bytes have, and nothing keeps it", async () => {
    const res = await world()("w1:p1", ID_PNG);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''q1.png");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  test("a file of no media type is a download", async () => {
    const res = await world()("w1:p1", ID_PDF);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''report.pdf");
  });

  test("a removed file, an id the log never named and an unknown pane are 404", async () => {
    const get = world();
    expect((await get("w1:p1", ID_GONE)).status).toBe(404);
    expect((await get("w1:p1", ID_ELSEWHERE)).status).toBe(404);
    expect((await get("w9:p9", ID_PNG)).status).toBe(404);
  });

  test("an id of the wrong shape is refused before any log is read", async () => {
    expect((await world()("w1:p1", "../../q1.png")).status).toBe(400);
  });
});
