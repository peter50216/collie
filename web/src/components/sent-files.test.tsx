import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SentFilesView } from "@/components/sent-files";
import { itemsOf } from "@/lib/chat-items";
import { __resetSentFiles } from "@/lib/sent-file-cache";
import type { SentFiles, TranscriptEntry } from "@/lib/types";
import { server } from "@/test/setup";

// Files the agent sent with Claude Code's SendUserFile (ADR 0160): a picture loads at once, a video,
// a sound and any other file wait for a tap, and every byte comes from the pane's own route.

const PNG_ID = "db0d772a-fcee-4459-aea5-fddc46fa1e82";
const MP4_ID = "e1274e22-8605-4ebc-add2-52f7b7568f33";
const MP3_ID = "0f3a8b55-2c4d-4e6f-8a9b-0c1d2e3f4a5b";
const PDF_ID = "11111111-2222-4333-8444-555555555555";

const SENT: SentFiles = {
  caption: "Question 1",
  files: [
    { id: PNG_ID, name: "q1.png", kind: "image", mediaType: "image/png", size: 7_450_146 },
    { id: MP4_ID, name: "run.mp4", kind: "video", mediaType: "video/mp4", size: 3_000_000 },
    { id: MP3_ID, name: "voice.mp3", kind: "audio", mediaType: "audio/mpeg", size: 40_000 },
    { id: PDF_ID, name: "report.pdf", kind: "file", mediaType: "application/pdf", size: 900 },
  ],
};

function asked(): string[] {
  const urls: string[] = [];
  server.use(
    http.get("/api/pane/:pane/sent-file/:id", ({ request, params }) => {
      urls.push(new URL(request.url).pathname + new URL(request.url).search);
      if (params.id === PDF_ID) return new HttpResponse("gone", { status: 404 });
      return new HttpResponse(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } });
    }),
  );
  return urls;
}

function show(sent: SentFiles = SENT, path = "/pane/w1:p1?host=laptop") {
  const router = createMemoryRouter([{ path: "/pane/:paneId", element: <SentFilesView sent={sent} scope={{ host: "laptop" }} /> }], {
    initialEntries: [path],
  });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => __resetSentFiles());

describe("SentFilesView", () => {
  it("draws the caption, loads the picture at once and nothing else", async () => {
    const urls = asked();
    show();
    expect(screen.getByText("Question 1")).toBeTruthy();
    await screen.findByAltText("q1.png");
    expect(urls).toEqual([`/api/pane/w1%3Ap1/sent-file/${PNG_ID}?host=laptop`]);
    expect(screen.getByText("run.mp4")).toBeTruthy();
    expect(screen.getByText("voice.mp3")).toBeTruthy();
    expect(document.querySelector("video")).toBeNull();
    expect(document.querySelector("audio")).toBeNull();
  });

  it("plays a video and a sound only after a tap", async () => {
    asked();
    show();
    const [videoPlay, audioPlay] = screen.getAllByRole("button", { name: "Load and play" });
    fireEvent.click(videoPlay!);
    await waitFor(() => expect(document.querySelector("video")?.getAttribute("src")).toMatch(/^blob:/));
    fireEvent.click(audioPlay!);
    await waitFor(() => expect(document.querySelector("audio")?.getAttribute("src")).toMatch(/^blob:/));
  });

  it("says a file is gone when the bridge answers 404", async () => {
    asked();
    show();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await screen.findByText("This file is no longer on the machine");
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("downloads a file under its own name", async () => {
    asked();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    show({ files: [{ id: MP3_ID, name: "notes.zip", kind: "file", size: 3 }] });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    const anchor = click.mock.contexts[0];
    if (!(anchor instanceof HTMLAnchorElement)) throw new Error("the click was not on a link");
    expect(anchor.download).toBe("notes.zip");
    expect(anchor.href).toMatch(/^blob:/);
    click.mockRestore();
  });

  it("outside a pane's view shows the names with nothing to tap", () => {
    const router = createMemoryRouter([{ path: "/", element: <SentFilesView sent={SENT} /> }]);
    render(<RouterProvider router={router} />);
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("buildChatItems", () => {
  it("draws a SendUserFile call as the files, in place of its card", () => {
    const entry: TranscriptEntry = {
      uuid: "a1",
      ts: "2026-11-20T06:22:24.093Z",
      role: "assistant",
      parts: [{ kind: "tool", name: "SendUserFile", summary: "q1.png", id: "toolu_1", result: { text: "1 file delivered", sent: SENT } }],
    };
    const items = itemsOf(entry);
    expect(items.map((i) => i.kind)).toEqual(["sent"]);
    expect(items[0]?.kind === "sent" ? items[0].sent : null).toEqual(SENT);
  });
});
