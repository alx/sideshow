// Push-to-talk button for the session head.
//
// Hold the button — or hold the SPACE key — like pi-voicekit: the take only
// arms after holding ≥ HOLD_MS, and the button shows a Bootstrap-style
// animated-stripes progress bar filling up while you wait. Release before
// the threshold and nothing is recorded. Once capture starts the bar is
// replaced by the pulsing live dot.
//
// On release the full pipeline runs server-side and the button mirrors its
// thinking steps as a spinner label: saving → publishing the audio card →
// transcribing (same Parakeet model as pi-voicekit) → upgrading the note with
// transcript + mp3 → handing the transcript to Pi (pi-sideshow-voice →
// pi.sendUserMessage, the same path as pi-voicekit auto-submit).
import { createSignal, onMount, onCleanup } from "solid-js";
import { api, appPath } from "./api.ts";
import { selected } from "./state.ts";

type Phase = "idle" | "arming" | "starting" | "recording" | "working";

// Same deliberate-hold default pi-voicekit ships (voice.holdThresholdMs).
const HOLD_MS = 700;
const POLL_MS = 600;
const WORK_TIMEOUT_MS = 120_000;
const DONE_SHOW_MS = 2500;
const ERROR_SHOW_MS = 5000;

// Solid types the style prop as a kebab-case CSSProperties, but the runtime
// setter needs the camelCase `animationDuration`. A plain (non-literal) object
// sidesteps the excess-property check without changing what reaches the DOM.
const PTT_FILL_STYLE = { animationDuration: `${HOLD_MS}ms, 800ms` };

interface JobView {
  id: string;
  state: "running" | "done" | "error";
  step: string;
  transcript?: string;
  error?: string;
  sentToPi?: boolean;
}

export function PushToTalk() {
  const [phase, setPhase] = createSignal<Phase>("idle");
  // The detailed step is surfaced on the voice card's footer (VoiceProgress);
  // the button only needs to know it is "working", so the value side stays
  // unread here (kept for a future in-button label).
  const [_stepLabel, setStepLabel] = createSignal("");
  const [error, setError] = createSignal("");
  let holding = false;
  let armingTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let working = false;

  // Browser-side capture state: when the page is on a secure context the mic
  // belongs to THIS device (the one watching the board), not the server host.
  let clientMode = false;
  let mediaRecorder: MediaRecorder | null = null;
  let mediaStream: MediaStream | null = null;
  let recChunks: BlobPart[] = [];

  const label = () => {
    switch (phase()) {
      case "arming":
        return "Hold…";
      case "starting":
        return "Starting…";
      case "recording":
        return "Listening… release to stop";
      case "working":
        // The detailed Pi step now lives on the voice card's footer
        // (VoiceProgress) — the button just stays quiet while the take lands.
        return "Working…";
      default:
        return error() ? error() : "Push to talk";
    }
  };

  const clearTimers = () => {
    if (armingTimer) clearTimeout(armingTimer);
    armingTimer = null;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
  };

  const finish = (isError: boolean) => {
    clearTimers();
    working = false;
    settleTimer = setTimeout(
      () => {
        setPhase("idle");
        setStepLabel("");
        setError("");
      },
      isError ? ERROR_SHOW_MS : DONE_SHOW_MS,
    );
  };

  const browserMicAvailable = () =>
    isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const pickMimeType = (): string | undefined => {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ];
    for (const c of candidates) {
      if (typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(c))
        return c;
    }
    return undefined;
  };

  const stopMediaTracks = () => {
    mediaStream?.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    mediaRecorder = null;
  };

  const startCapture = async () => {
    armingTimer = null;
    setPhase("starting");
    if (browserMicAvailable()) {
      try {
        await api("/api/voice/start", {
          method: "POST",
          body: JSON.stringify({ capture: "client" }),
        });
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        const mimeType = pickMimeType();
        mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
        recChunks = [];
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size) recChunks.push(e.data);
        };
        mediaRecorder.start(250);
        clientMode = true;
        holding = true;
        setPhase("recording");
        return;
      } catch {
        // Permission denied / no device — drop the partial client take and
        // fall back to the host capture below (the server's own mic).
        stopMediaTracks();
        setError(
          "Browser mic unavailable — using the server's microphone (open via https for this device's mic)",
        );
        setTimeout(() => setError(""), 6000);
      }
    }
    try {
      await api("/api/voice/start", { method: "POST", body: "{}" });
      clientMode = false;
      holding = true;
      setPhase("recording");
    } catch (e: any) {
      setPhase("idle");
      setError(e?.message ?? "could not start recording");
      setTimeout(() => setError(""), 5000);
    }
  };

  /** Begin an armed hold; the take only starts after HOLD_MS. */
  const arm = () => {
    if (holding || working || armingTimer) return;
    setError("");
    setPhase("arming");
    armingTimer = setTimeout(() => void startCapture(), HOLD_MS);
  };

  /** Any release ends the current gesture: cancel an armed hold, or stop. */
  const release = () => {
    if (armingTimer) {
      clearTimeout(armingTimer);
      armingTimer = null;
      setPhase("idle");
      return;
    }
    if (holding) void stop();
  };

  const stop = async () => {
    if (!holding) return;
    holding = false;
    try {
      if (clientMode) {
        // Flush the recorder, then upload the take from THIS device's mic.
        const blob = await new Promise<Blob>((resolve) => {
          const rec = mediaRecorder;
          if (!rec) return resolve(new Blob());
          rec.onstop = () => resolve(new Blob(recChunks, { type: rec.mimeType || "audio/webm" }));
          try {
            rec.stop();
          } catch {
            resolve(new Blob());
          }
        });
        stopMediaTracks();
        clientMode = false;
        const session = selected() ?? null;
        const qs = session ? `?session=${encodeURIComponent(session)}` : "";
        const res = await fetch(appPath(`/api/voice/stop${qs}`), {
          method: "POST",
          headers: { "content-type": blob.type || "audio/webm" },
          body: blob,
        });
        const data = (await res.json().catch(() => ({}))) as {
          jobId?: string;
          error?: string;
        };
        if (!res.ok || !data.jobId) throw new Error(data.error || String(res.status));
        working = true;
        setPhase("working");
        setStepLabel("Saving audio…");
        pollJob(data.jobId, Date.now());
        return;
      }
      const res = await api<{ jobId: string }>("/api/voice/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: selected() ?? null }),
      });
      working = true;
      setPhase("working");
      setStepLabel("Saving audio…");
      pollJob(res.jobId, Date.now());
    } catch (e: any) {
      setPhase("idle");
      setError(e?.message ?? "could not finish recording");
      setTimeout(() => setError(""), 5000);
    }
  };

  const pollJob = (jobId: string, startedAt: number) => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const job = await api<JobView>(`/api/voice/jobs/${jobId}`);
        setStepLabel(job.step);
        if (job.state !== "running") {
          if (job.state === "error") setError(job.error || job.step);
          finish(job.state === "error");
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (Date.now() - startedAt > WORK_TIMEOUT_MS) {
        setStepLabel("Still working…");
        finish(false);
        return;
      }
      pollTimer = setTimeout(tick, POLL_MS);
    };
    pollTimer = setTimeout(tick, POLL_MS);
  };

  // SPACE is the primary push-to-talk trigger (button is the fallback).
  // Skipped while typing in a field or while a modal/menu has the user's
  // attention; any release stops on window blur so alt-tab can't leave a
  // take open.
  onMount(() => {
    const inEditable = (t: EventTarget | null) =>
      t instanceof Element &&
      (!!t.closest("input, textarea, select, [contenteditable='true']") ||
        (t as HTMLElement).isContentEditable);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (inEditable(e.target)) return;
      if (document.querySelector(".modal, [role='menu']")) return;
      if (e.repeat) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      arm();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (inEditable(e.target)) return;
      e.preventDefault();
      release();
    };
    const onBlur = () => release();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      // Never leave a take open if the component goes away mid-hold.
      clearTimers();
      if (holding) void stop();
    });
  });

  return (
    <button
      class="ptt"
      classList={{
        "ptt-live": phase() === "recording" || phase() === "starting",
        "ptt-arming": phase() === "arming",
        "ptt-working": phase() === "working",
        "ptt-error": error() !== "",
      }}
      aria-label="Push to talk — hold for a moment to record (or hold space)"
      title="Hold to talk (or hold SPACE) — keep holding for a moment to start. The take is published as an audio card, transcribed, and sent to Pi."
      onPointerDown={(e) => {
        e.preventDefault();
        // Don't keep focus — a focused button would swallow spacebar presses
        // (button activation) and the keydown handler below. Space is PTT.
        e.currentTarget.blur();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* pointer already gone */
        }
        arm();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      {phase() === "working" ? (
        <span class="ptt-spin" aria-hidden="true"></span>
      ) : phase() === "arming" ? (
        <span class="ptt-track" aria-hidden="true">
          <span class="ptt-fill" style={PTT_FILL_STYLE}></span>
        </span>
      ) : (
        <span class="ptt-dot" aria-hidden="true"></span>
      )}
      <span class="ptt-label">{label()}</span>
    </button>
  );
}
