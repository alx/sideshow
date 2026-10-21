// Push-to-talk capture for the viewer.
//
// Input mirrors pi-voicekit exactly: same tool priority (sox `rec` → ffmpeg →
// arecord, ffmpeg first when PULSE_SERVER is set), same default-input device,
// 16 kHz mono 16-bit PCM on stdout. The captured PCM is converted to an mp3
// under ~/.sideshow/voice/ and served at /voice/<file>.mp3 so a post's html
// surface can embed <audio src="/voice/<file>.mp3">.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
// Hard ceiling on one take — the child is killed; the next /stop finalizes it.
const MAX_RECORDING_MS = 10 * 60 * 1000;

export const voiceDir = (): string => {
  const dir = process.env.SIDESHOW_VOICE_DIR ?? join(homedir(), ".sideshow", "voice");
  return dir;
};

type ToolName = "sox" | "ffmpeg" | "arecord" | "browser";

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface CaptureTool {
  name: ToolName;
  cmd: string;
  args: string[];
}

function commandExists(cmd: string): boolean {
  try {
    const res = spawnSync("which", [cmd], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

// Same probes as pi-voicekit's audio-tool.ts (sox rec → ffmpeg → arecord).
function probeSox(): CaptureTool | null {
  if (!commandExists("rec")) return null;
  return {
    name: "sox",
    cmd: "rec",
    args: [
      "-q",
      "--buffer",
      "4096",
      "-c",
      String(CHANNELS),
      "-b",
      "16",
      "-e",
      "signed-integer",
      "-t",
      "raw",
      "-",
      "rate",
      String(SAMPLE_RATE),
    ],
  };
}

function probeFfmpeg(): CaptureTool | null {
  if (!commandExists("ffmpeg")) return null;
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  const inputArgs = isMac
    ? ["-f", "avfoundation", "-i", ":default"]
    : isWin
      ? ["-f", "dshow", "-i", "audio=Microphone"]
      : ["-f", "pulse", "-i", "default"];
  return {
    name: "ffmpeg",
    cmd: "ffmpeg",
    args: [
      ...inputArgs,
      "-ac",
      String(CHANNELS),
      "-ar",
      String(SAMPLE_RATE),
      "-sample_fmt",
      "s16",
      "-f",
      "s16le",
      "-loglevel",
      "error",
      "pipe:1",
    ],
  };
}

function probeArecord(): CaptureTool | null {
  if (process.platform !== "linux" || !commandExists("arecord")) return null;
  return {
    name: "arecord",
    cmd: "arecord",
    args: ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", String(CHANNELS), "-t", "raw"],
  };
}

let cachedTool: CaptureTool | null | undefined;
function detectCaptureTool(): CaptureTool | null {
  if (cachedTool !== undefined) return cachedTool;
  const order: (() => CaptureTool | null)[] = [probeSox, probeFfmpeg, probeArecord];
  // pi-voicekit prefers ffmpeg when PULSE_SERVER is set (remote pulse tunnels).
  if (process.env.PULSE_SERVER) order.reverse();
  for (const probe of order) {
    const tool = probe();
    if (tool) {
      cachedTool = tool;
      return tool;
    }
  }
  cachedTool = null;
  return null;
}

export interface Recording {
  id: string;
  tool: ToolName;
  startedAt: string;
}

interface ActiveServer {
  id: string;
  mode: "server";
  tool: CaptureTool;
  proc: ChildProcess;
  stream: WriteStream;
  tmpPath: string;
  startedAt: number;
  timer: NodeJS.Timeout;
}

interface ActiveClient {
  id: string;
  mode: "client";
  startedAt: number;
  timer: NodeJS.Timeout;
}

type Active = ActiveServer | ActiveClient;

let active: Active | null = null;

function tmpPcmPath(id: string): string {
  return join("/tmp", `sideshow-voice-${id}.pcm`);
}

export async function startVoiceRecording(opts?: {
  capture?: "client";
}): Promise<Recording | { error: string; status: 409 | 500 }> {
  if (active) return { error: "a recording is already in progress", status: 409 };
  const id = genId();
  // Client capture: the browser records its own microphone (getUserMedia +
  // MediaRecorder) and uploads the take to /stop. Needed when the viewer is
  // on another machine than the server — the host mic is the wrong device.
  if (opts?.capture === "client") {
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      if (active && active.id === id) {
        console.log(`[sideshow voice] max duration reached, dropping client take ${id}`);
        active = null;
      }
    }, MAX_RECORDING_MS);
    active = { id, mode: "client", startedAt, timer };
    return { id, tool: "browser", startedAt: new Date(startedAt).toISOString() };
  }
  const tool = detectCaptureTool();
  if (!tool) {
    return { error: "no audio capture tool found — install sox or ffmpeg", status: 500 };
  }
  const tmpPath = tmpPcmPath(id);
  const stream = createWriteStream(tmpPath);
  const proc = spawn(tool.cmd, tool.args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout?.pipe(stream);
  // Capture stderr to keep the parent's logs clean but surface real failures.
  let stderr = "";
  proc.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  proc.on("error", (err) => {
    console.error(`[sideshow voice] capture spawn error: ${err.message}`);
  });
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    if (active && active.id === id && active.mode === "server") {
      console.log(`[sideshow voice] max duration reached, killing capture ${id}`);
      killCapture(active.proc);
    }
  }, MAX_RECORDING_MS);
  active = {
    id,
    mode: "server",
    tool,
    proc,
    stream,
    tmpPath,
    startedAt,
    timer: timer as unknown as NodeJS.Timeout,
  };
  void stderr;
  return { id, tool: tool.name, startedAt: new Date(startedAt).toISOString() };
}

function killCapture(proc: ChildProcess): void {
  // sox/arecord flush cleanly on SIGINT; ffmpeg on SIGTERM. A blocked child
  // (e.g. parked in a TCC mic-permission wait) may ignore SIGINT, so escalate
  // unconditionally — do NOT gate on proc.killed, which Node sets to true after
  // the first proc.kill() call even if the child is still alive.
  try {
    proc.kill("SIGINT");
  } catch {
    /* already dead */
  }
  setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }, 1500).unref?.();
}

export interface RecordingResult {
  id: string;
  file: string;
  url: string;
  tool: ToolName;
  ms: number;
  bytes: number;
  /** Raw 16 kHz mono s16le take — kept for STT after the mp3 is written. */
  pcm: Buffer;
}

export interface UploadTake {
  bytes: Buffer;
  contentType?: string;
}

export async function stopVoiceRecording(
  upload?: UploadTake,
): Promise<RecordingResult | { error: string; status: 409 | 400 | 500 }> {
  const cur = active;
  if (upload?.bytes) {
    // Browser-captured take: the client uploads the MediaRecorder container
    // (webm/m4a/…). Adopt the in-flight recording's id when there is one so
    // the job the viewer is polling stays valid.
    const id = cur?.id ?? genId();
    if (cur) {
      active = null;
      clearTimeout(cur.timer);
      if (cur.mode === "server") killCapture(cur.proc);
    }
    return finishUploadedTake(id, upload.bytes, upload.contentType);
  }
  if (!cur) return { error: "no recording in progress", status: 409 };
  active = null;
  clearTimeout(cur.timer);
  if (cur.mode === "client") {
    return { error: "client capture requires an uploaded take", status: 400 };
  }
  killCapture(cur.proc);

  // Wait for the child to actually exit so its stdout flush finishes.
  const exited = await new Promise<boolean>((resolve) => {
    if (cur.proc.exitCode !== null || cur.proc.signalCode !== null) return resolve(true);
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Escalate right away; killCapture's SIGKILL is due by now or imminent.
      try {
        cur.proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      resolve(false);
    }, 2000);
    cur.proc.once("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(true);
    });
  });
  try {
    await new Promise<void>((resolve) => cur.stream.end(resolve));
  } catch {
    /* stream already closed */
  }
  if (exited === false) {
    try {
      await unlink(cur.tmpPath);
    } catch {
      /* ignore */
    }
    return { error: "capture process did not finish", status: 500 as const };
  }

  let pcm: Buffer | null = null;
  try {
    pcm = await readFile(cur.tmpPath);
  } catch {
    pcm = null;
  }
  const pcmBytes = pcm?.length ?? 0;
  if (pcmBytes < 320) {
    // 16-bit mono @16 kHz → 32 B/s; below this there is effectively no audio.
    try {
      await unlink(cur.tmpPath);
    } catch {
      /* ignore */
    }
    return { error: "no audio captured — is a microphone connected and allowed?", status: 400 };
  }

  const dir = voiceDir();
  await mkdir(dir, { recursive: true });
  const outFile = join(dir, `${cur.id}.mp3`);
  // Convert the raw PCM take to an mp3 the browser can play.
  const conv = spawn(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      String(CHANNELS),
      "-i",
      cur.tmpPath,
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      outFile,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const convOk = await new Promise<boolean>((resolve) => {
    let err = "";
    conv.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    conv.once("error", () => resolve(false));
    conv.once("close", (code) => {
      void err;
      resolve(code === 0);
    });
  });
  try {
    await unlink(cur.tmpPath);
  } catch {
    /* ignore */
  }
  if (!convOk) {
    try {
      await unlink(outFile);
    } catch {
      /* ignore */
    }
    return { error: "mp3 conversion failed (is ffmpeg installed?)", status: 500 as const };
  }
  const mp3Bytes = (await stat(outFile)).size;
  return {
    id: cur.id,
    file: `${cur.id}.mp3`,
    url: `/voice/${cur.id}.mp3`,
    tool: cur.tool.name,
    ms: Math.round((pcmBytes / (2 * CHANNELS) / SAMPLE_RATE) * 1000),
    bytes: mp3Bytes,
    pcm: pcm ?? Buffer.alloc(0),
  };
}

const CLIENT_CONTAINER_EXT: Record<string, string> = {
  "video/webm": "webm",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "video/mp4": "m4a",
  "audio/ogg": "ogg",
  "video/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

function ffmpegToPcm(input: string): Promise<{ ok: boolean; pcm?: Buffer; err?: string }> {
  return new Promise((resolve) => {
    const p = spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        input,
        "-f",
        "s16le",
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        String(CHANNELS),
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let err = "";
    p.stdout?.on("data", (d: Buffer) => chunks.push(d));
    p.stderr?.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-400)));
    p.once("error", (e: Error) => resolve({ ok: false, err: e.message }));
    p.once("close", (code) =>
      code === 0 ? resolve({ ok: true, pcm: Buffer.concat(chunks) }) : resolve({ ok: false, err }),
    );
  });
}

async function finishUploadedTake(
  id: string,
  bytes: Buffer,
  contentType?: string,
): Promise<RecordingResult | { error: string; status: 400 | 500 }> {
  if (bytes.length < 64) {
    return { error: "empty upload — nothing recorded", status: 400 as const };
  }
  const ext = CLIENT_CONTAINER_EXT[contentType?.toLowerCase() ?? ""] ?? "webm";
  const dir = voiceDir();
  await mkdir(dir, { recursive: true });
  const upPath = join(dir, `${id}.upload-${ext}`);
  const outFile = join(dir, `${id}.mp3`);
  try {
    await writeFile(upPath, bytes);
    const pcmPromise = ffmpegToPcm(upPath);
    const conv = spawn(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", upPath, "-codec:a", "libmp3lame", "-b:a", "128k", outFile],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const convOk = await new Promise<boolean>((resolve) => {
      conv.once("error", () => resolve(false));
      conv.once("close", (code) => resolve(code === 0));
    });
    const { ok, pcm, err } = await pcmPromise;
    if (!convOk || !ok || !pcm || pcm.length < 320) {
      await unlink(outFile).catch(() => {});
      return {
        error: `could not decode uploaded take${err ? ` (${err.slice(-200)})` : " — empty"}`,
        status: 500 as const,
      };
    }
    return {
      id,
      file: `${id}.mp3`,
      url: `/voice/${id}.mp3`,
      tool: "browser",
      ms: Math.round((pcm.length / (2 * CHANNELS) / SAMPLE_RATE) * 1000),
      bytes: (await stat(outFile)).size,
      pcm,
    };
  } finally {
    await unlink(upPath).catch(() => {});
  }
}

export function resolveVoiceFile(name: string): string | null {
  if (!/^[A-Za-z0-9._-]+\.mp3$/.test(name)) return null;
  const file = join(voiceDir(), name);
  return existsSync(file) ? file : null;
}
