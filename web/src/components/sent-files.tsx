import { useEffect, useState } from "react";
import { useParams } from "react-router";

import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";
import { MarkdownText } from "@/components/markdown-text";
import { Button } from "@/components/ui/button";
import { ImageSheet } from "@/components/ui/image-sheet";
import { isApiErrorStatus, sentFilePath } from "@/lib/api";
import { formatBytes } from "@/lib/files-view";
import { t } from "@/lib/i18n";
import { heldSentFile, loadSentFile } from "@/lib/sent-file-cache";
import type { Scope } from "@/lib/scope";
import type { SentFile, SentFiles } from "@/lib/types";
import { useLocale } from "@/hooks/use-locale";

// ── WHAT THE AGENT SENT (Claude Code's SendUserFile, ADR 0175) ───────────────────────────────────
//
// A call that put files in front of the person draws as the files themselves, the way claude.ai
// draws them: the caption, then a picture, a player or a download for each file.
//
// THE BYTES CARRY THE PAIRING TOKEN. Reads need it (ADR 0086), and an `<img src>` or a `<video src>`
// cannot send it, so each file is fetched whole and shown from an object URL. A picture loads at
// once. A video, a sound and any other file load on a tap: one may be 100 MB, and a phone on a
// cellular link must not spend that on a scroll. The bytes are kept for the page in
// `lib/sent-file-cache.ts`.
/** The state of one file on this page: not asked for, on its way, here, or refused. */
type FileState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "failed"; reason: "gone" | "too-large" | "other" };

function failure(err: Error): FileState {
  if (isApiErrorStatus(err, 404)) return { kind: "failed", reason: "gone" };
  if (isApiErrorStatus(err, 413)) return { kind: "failed", reason: "too-large" };
  return { kind: "failed", reason: "other" };
}

/** What {@link useSentFile} hands a card: the file's state, and `start` to fetch it. */
interface SentFileHandle {
  state: FileState;
  start: () => void;
}

/** The file's state, and `start` to fetch it. `auto` fetches on mount. A file fetched before is ready at once. */
function useSentFile(path: string | null, auto: boolean): SentFileHandle {
  const [state, setState] = useState<FileState>(() => {
    const hit = path === null ? undefined : heldSentFile(path);
    return hit === undefined ? { kind: "idle" } : { kind: "ready", url: hit.url };
  });
  // How many times the file was asked for: one on mount for a picture, one per tap otherwise. A tap
  // after a failure asks again, because a failed load is not kept.
  const [attempt, setAttempt] = useState(auto ? 1 : 0);
  useEffect(() => {
    if (path === null || attempt === 0) return;
    let live = true;
    const hit = heldSentFile(path);
    if (hit !== undefined) {
      setState({ kind: "ready", url: hit.url });
      return;
    }
    setState({ kind: "loading" });
    const fetchIt = async () => {
      try {
        const entry = await loadSentFile(path);
        if (live) setState({ kind: "ready", url: entry.url });
      } catch (err) {
        if (live) setState(failure(err instanceof Error ? err : new Error(String(err))));
      }
    };
    void fetchIt();
    return () => {
      live = false;
    };
  }, [path, attempt]);
  return { state, start: () => setAttempt((n) => n + 1) };
}

const KIND_ICON = {
  image: "image",
  video: "sent-video",
  audio: "sent-audio",
  file: "file",
} as const satisfies Record<SentFile["kind"], IconKey>;

function failureText(reason: "gone" | "too-large" | "other"): string {
  if (reason === "gone") return t("transcript.sentFileGone");
  if (reason === "too-large") return t("transcript.sentFileTooLarge");
  return t("transcript.sentFileFailed");
}

/**
 * The card a file shows before its bytes are here, and after a refusal: the kind, the name and the
 * size, and the one action the kind takes. A refusal replaces the action with what went wrong, and a
 * failure the person can retry stays a button.
 */
function FileRow({ file, state, action, onAct }: { file: SentFile; state: FileState; action: string; onAct?: () => void }) {
  const size = file.size === undefined ? null : formatBytes(file.size);
  const failed = state.kind === "failed" ? state.reason : null;
  return (
    <div data-slot="sent-file" className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-2">
      <Icon name={failed === null ? KIND_ICON[file.kind] : "warning"} className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs">{file.name}</div>
        <div className="text-xs text-muted-foreground">
          {failed === null ? size : failureText(failed)}
        </div>
      </div>
      {onAct !== undefined && failed !== "gone" && failed !== "too-large" && (
        <Button type="button" variant="outline" size="sm" disabled={state.kind === "loading"} onClick={onAct}>
          {state.kind === "loading" ? t("transcript.sentFileLoading") : action}
        </Button>
      )}
    </div>
  );
}

function SentImage({ file, path }: { file: SentFile; path: string | null }) {
  const { state, start } = useSentFile(path, true);
  if (state.kind === "ready") {
    return (
      <ImageSheet
        src={state.url}
        alt={file.name}
        title={file.name}
        imgClassName="max-h-96 w-auto max-w-full rounded border object-contain shadow-xs"
      />
    );
  }
  // THE RESERVE, WHILE THE BYTES COME: the `PagerPicture` height, as `JournalImage` keeps it.
  if (state.kind === "loading" || (state.kind === "idle" && path !== null)) {
    return <span aria-hidden data-slot="sent-file-reserve" className="block h-40 w-full" />;
  }
  return <FileRow file={file} state={state} action={t("transcript.sentFilePlay")} onAct={path === null ? undefined : start} />;
}

// A file an agent sent carries no caption track of its own, so each player declares an empty one:
// the browser offers no captions, and the call's own caption is drawn above the player as text.
function SentMedia({ file, path }: { file: SentFile; path: string | null }) {
  const { state, start } = useSentFile(path, false);
  if (state.kind === "ready" && file.kind === "video") {
    return (
      <video controls playsInline preload="metadata" src={state.url} aria-label={file.name} className="max-h-96 w-full rounded border bg-black">
        <track kind="captions" />
      </video>
    );
  }
  if (state.kind === "ready") {
    return (
      <div className="flex flex-col gap-1">
        <div className="truncate font-mono text-xs text-muted-foreground">{file.name}</div>
        <audio controls preload="metadata" src={state.url} aria-label={file.name} className="w-full">
          <track kind="captions" />
        </audio>
      </div>
    );
  }
  return <FileRow file={file} state={state} action={t("transcript.sentFilePlay")} onAct={path === null ? undefined : start} />;
}

/** A download: the bytes are fetched with the token, then handed to the browser under the file's name. */
function SentDownload({ file, path }: { file: SentFile; path: string | null }) {
  const [state, setState] = useState<FileState>({ kind: "idle" });
  const download = async () => {
    if (path === null) return;
    setState({ kind: "loading" });
    try {
      const entry = await loadSentFile(path);
      const a = document.createElement("a");
      a.href = entry.url;
      a.download = file.name;
      a.rel = "noopener";
      a.click();
      setState({ kind: "idle" });
    } catch (err) {
      setState(failure(err instanceof Error ? err : new Error(String(err))));
    }
  };
  return <FileRow file={file} state={state} action={t("transcript.sentFileDownload")} onAct={path === null ? undefined : () => void download()} />;
}

function OneFile({ file, paneId, scope }: { file: SentFile; paneId: string | undefined; scope?: Scope }) {
  const path = paneId === undefined ? null : sentFilePath(paneId, file.id, scope);
  if (file.kind === "image") return <SentImage file={file} path={path} />;
  if (file.kind === "video" || file.kind === "audio") return <SentMedia file={file} path={path} />;
  return <SentDownload file={file} path={path} />;
}

/**
 * What one `SendUserFile` call sent: the caption as the agent's prose, then each file. `paneId` is
 * the pane whose log named the files; the route under it is the only place the bytes are. Outside a
 * pane's view (no pane id) the files show as their names, with nothing to tap.
 */
export function SentFilesView({ sent, paneId, scope }: { sent: SentFiles; paneId?: string; scope?: Scope }) {
  useLocale();
  const params = useParams();
  const pane = paneId ?? params.paneId;
  return (
    <div data-slot="sent-files" className="flex min-w-0 flex-col gap-1.5" aria-label={t("transcript.sentFileAlt")}>
      {sent.caption !== undefined && <MarkdownText text={sent.caption} />}
      {sent.files.map((file) => (
        <OneFile key={file.id} file={file} paneId={pane} scope={scope} />
      ))}
    </div>
  );
}
