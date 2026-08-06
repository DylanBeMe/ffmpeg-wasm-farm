import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import { ParallelFFmpeg } from "../../src/index.ts";
import type { FarmLog, FarmProgress, PipelineStage } from "../../src/index.ts";

const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const MAX_LOG_ROWS = 250;

interface Preset {
  description: string;
  extension: string;
  mime: string;
  audioStrategy: "single-pass" | "drop";
  encodingArgs: string[];
  audioArgs: string[];
  muxArgs: string[];
}

const PRESETS: Record<string, Preset> = {
  balanced: {
    description: "H.264 at CRF 23 with AAC audio. A reliable default for sharing.",
    extension: "mp4",
    mime: "video/mp4",
    audioStrategy: "single-pass",
    encodingArgs: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"],
    audioArgs: ["-c:a", "aac", "-b:a", "128k"],
    muxArgs: ["-movflags", "+faststart"],
  },
  compact: {
    description: "Smaller H.264 output at CRF 28 with 96 kbps AAC audio.",
    extension: "mp4",
    mime: "video/mp4",
    audioStrategy: "single-pass",
    encodingArgs: ["-c:v", "libx264", "-preset", "faster", "-crf", "28", "-pix_fmt", "yuv420p"],
    audioArgs: ["-c:a", "aac", "-b:a", "96k"],
    muxArgs: ["-movflags", "+faststart"],
  },
  webm: {
    description: "VP9 with Opus audio. Efficient, but slower to encode than H.264.",
    extension: "webm",
    mime: "video/webm",
    audioStrategy: "single-pass",
    encodingArgs: ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "0"],
    audioArgs: ["-c:a", "libopus", "-b:a", "96k"],
    muxArgs: [],
  },
  "video-only": {
    description: "H.264 video without audio. Useful for silent loops and previews.",
    extension: "mp4",
    mime: "video/mp4",
    audioStrategy: "drop",
    encodingArgs: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"],
    audioArgs: [],
    muxArgs: ["-movflags", "+faststart"],
  },
};

const STAGE_LABELS: Record<PipelineStage, string> = {
  "loading-planner": "Loading planner",
  "extracting-audio": "Encoding audio",
  splitting: "Splitting at keyframes",
  "loading-workers": "Starting workers",
  transcoding: "Encoding segments",
  assembling: "Assembling output",
  done: "Export complete",
};

const $ = <T extends Element>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing required element: ${selector}`);
  return node;
};

const fileInput = $("#file-input") as HTMLInputElement;
const dropzone = $("#dropzone") as HTMLLabelElement;
const fileSummary = $("#file-summary") as HTMLDivElement;
const fileName = $("#file-name") as HTMLElement;
const fileMeta = $("#file-meta") as HTMLElement;
const clearFileButton = $("#clear-file") as HTMLButtonElement;
const presetSelect = $("#preset") as HTMLSelectElement;
const presetDescription = $("#preset-description") as HTMLElement;
const outputNameInput = $("#output-name") as HTMLInputElement;
const workerInput = $("#worker-count") as HTMLInputElement;
const workerValue = $("#worker-value") as HTMLOutputElement;
const workerWarning = $("#worker-warning") as HTMLElement;
const segmentInput = $("#segment-seconds") as HTMLInputElement;
const segmentValue = $("#segment-value") as HTMLOutputElement;
const resetSettingsButton = $("#reset-settings") as HTMLButtonElement;
const startButton = $("#start-button") as HTMLButtonElement;
const cancelButton = $("#cancel-button") as HTMLButtonElement;
const actionHint = $("#action-hint") as HTMLElement;
const jobState = $("#job-state") as HTMLElement;
const stageLabel = $("#stage-label") as HTMLElement;
const stageDetail = $("#stage-detail") as HTMLElement;
const progressNumber = $("#progress-number") as HTMLElement;
const progressTrack = $("#progress-track") as HTMLElement;
const progressBar = $("#progress-bar") as HTMLElement;
const errorAlert = $("#error-alert") as HTMLElement;
const errorMessage = $("#error-message") as HTMLElement;
const resultPreview = $("#result-preview") as HTMLElement;
const outputVideo = $("#output-video") as HTMLVideoElement;
const resultMeta = $("#result-meta") as HTMLElement;
const downloadOutput = $("#download-output") as HTMLAnchorElement;
const logView = $("#log-view") as HTMLElement;
const logCount = $("#log-count") as HTMLElement;
const clearLogButton = $("#clear-log") as HTMLButtonElement;
const activityStage = $("#activity-stage") as HTMLElement;
const activitySegments = $("#activity-segments") as HTMLElement;
const activityWorkers = $("#activity-workers") as HTMLElement;
const activityElapsed = $("#activity-elapsed") as HTMLElement;
const themeToggle = $("#theme-toggle") as HTMLButtonElement;
const detectedCores = $("#detected-cores") as HTMLElement;
const recommendedWorkers = $("#recommended-workers") as HTMLElement;

let selectedFile: File | undefined;
let abortController: AbortController | undefined;
let outputURL: string | undefined;
let coreConfigPromise: Promise<{ coreURL: string; wasmURL: string }> | undefined;
let logEntries = 0;
let startedAt = 0;
let elapsedTimer: number | undefined;
let lastWorkerCount = 0;

initializeTheme();
initializeTabs();
initializeHardwareControls();
initializeDropzone();
initializeSettings();
setProgress(0, "Choose a file to begin", "The FFmpeg core loads when the first export starts.");

startButton.addEventListener("click", () => void startExport());
cancelButton.addEventListener("click", cancelExport);
clearFileButton.addEventListener("click", clearFile);
clearLogButton.addEventListener("click", clearLog);
themeToggle.addEventListener("click", toggleTheme);

function initializeTheme(): void {
  let theme = "dark";
  try {
    theme = localStorage.getItem("framefarm-theme")
      ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  } catch {
    // Storage can be unavailable in private browsing contexts.
  }
  applyTheme(theme === "light" ? "light" : "dark");
}

function toggleTheme(): void {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  const nextTheme = theme === "dark" ? "light" : "dark";
  themeToggle.setAttribute("aria-label", `Switch to ${nextTheme} theme`);
  themeToggle.title = `Switch to ${nextTheme} theme`;
  try {
    localStorage.setItem("framefarm-theme", theme);
  } catch {
    // Theme still works for the current session.
  }
}

function initializeTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-tab]")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab ?? "transcode"));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      const next = tabs[nextIndex];
      next?.focus();
      next?.click();
    });
  });
}

function activateTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll<HTMLElement>(".tab-panel").forEach((panel) => {
    const active = panel.id === `panel-${name}`;
    panel.classList.toggle("is-hidden", !active);
    panel.hidden = !active;
  });
}

function initializeHardwareControls(): void {
  const cores = Math.max(1, navigator.hardwareConcurrency || 2);
  const recommended = ParallelFFmpeg.recommendedWorkerCount();
  const maximum = Math.max(1, Math.min(8, cores));
  detectedCores.textContent = `${cores} logical ${cores === 1 ? "core" : "cores"}`;
  recommendedWorkers.textContent = `${recommended} recommended ${recommended === 1 ? "worker" : "workers"}`;
  workerInput.max = String(maximum);
  workerInput.value = String(Math.min(recommended, maximum));
  updateRange(workerInput, workerValue, (value) => `${value}`);
}

function initializeDropzone(): void {
  fileInput.addEventListener("change", () => selectFile(fileInput.files?.[0]));
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  ["dragenter", "dragover"].forEach((name) => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
    });
  });
  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer?.files[0];
    selectFile(file);
  });
}

function initializeSettings(): void {
  presetSelect.addEventListener("change", () => applyPreset(true));
  workerInput.addEventListener("input", () => {
    updateRange(workerInput, workerValue, (value) => `${value}`);
    workerWarning.classList.toggle("is-hidden", Number(workerInput.value) <= 4);
  });
  segmentInput.addEventListener("input", () => {
    updateRange(segmentInput, segmentValue, (value) => `${value} seconds`);
  });
  resetSettingsButton.addEventListener("click", () => {
    presetSelect.value = "balanced";
    workerInput.value = String(Math.min(ParallelFFmpeg.recommendedWorkerCount(), Number(workerInput.max)));
    segmentInput.value = "12";
    applyPreset(true);
    updateRange(workerInput, workerValue, (value) => `${value}`);
    updateRange(segmentInput, segmentValue, (value) => `${value} seconds`);
    workerWarning.classList.add("is-hidden");
  });
  applyPreset(false);
  updateRange(segmentInput, segmentValue, (value) => `${value} seconds`);
}

function updateRange(
  input: HTMLInputElement,
  output: HTMLOutputElement,
  format: (value: number) => string,
): void {
  const value = Number(input.value);
  const min = Number(input.min);
  const max = Number(input.max);
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  input.style.setProperty("--range-progress", `${percent}%`);
  output.value = format(value);
}

function applyPreset(updateFilename: boolean): void {
  const preset = currentPreset();
  presetDescription.textContent = preset.description;
  if (updateFilename) {
    const base = outputNameInput.value.replace(/\.[^.]+$/, "") || "output";
    outputNameInput.value = `${base}.${preset.extension}`;
  }
}

function currentPreset(): Preset {
  return PRESETS[presetSelect.value] ?? PRESETS.balanced!;
}

function selectFile(file: File | undefined): void {
  if (!file) return;
  clearError();
  if (file.size === 0) {
    showError("The selected file is empty.");
    return;
  }
  if (file.type.startsWith("audio/") || /\.(?:aac|flac|m4a|mp3|opus|wav)$/i.test(file.name)) {
    showError("FrameFarm currently requires a source with a video stream.");
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  fileMeta.textContent = `${formatBytes(file.size)} · ${file.type || "format inferred from filename"}`;
  fileSummary.classList.remove("is-hidden");
  dropzone.classList.add("is-hidden");
  startButton.disabled = false;
  actionHint.textContent = file.size > 750 * 1024 * 1024
    ? "Large files may exceed browser memory. Start with fewer workers."
    : "Ready to process locally.";
  clearResult();
  clearError();
}

function clearFile(): void {
  if (abortController) return;
  selectedFile = undefined;
  fileInput.value = "";
  fileSummary.classList.add("is-hidden");
  dropzone.classList.remove("is-hidden");
  startButton.disabled = true;
  actionHint.textContent = "Select a source file first.";
  clearResult();
  clearError();
  setProgress(0, "Choose a file to begin", "The FFmpeg core loads when the first export starts.");
}

async function startExport(): Promise<void> {
  if (!selectedFile || abortController) return;
  clearError();
  clearResult();
  clearLog();
  abortController = new AbortController();
  lastWorkerCount = Number(workerInput.value);
  startedAt = performance.now();
  startElapsedTimer();
  setBusy(true);
  activityWorkers.textContent = String(lastWorkerCount);
  appendAppLog("system", `Starting ${lastWorkerCount} workers with ${segmentInput.value}-second segments.`);

  try {
    setProgress(0.005, "Preparing FFmpeg", "Downloading and compiling the core on the first run.");
    const loadConfig = await getCoreConfig();
    const preset = currentPreset();
    const normalizedOutputName = normalizeOutputName(outputNameInput.value, preset.extension);
    outputNameInput.value = normalizedOutputName;
    const farm = new ParallelFFmpeg(() => new FFmpeg());
    const result = await farm.transcode(selectedFile, {
      inputName: selectedFile.name,
      outputName: normalizedOutputName,
      workerCount: lastWorkerCount,
      segmentSeconds: Number(segmentInput.value),
      audioStrategy: preset.audioStrategy,
      audioArgs: preset.audioArgs,
      encodingArgs: preset.encodingArgs,
      muxArgs: preset.muxArgs,
      loadConfig,
      signal: abortController.signal,
      onProgress: updateProgress,
      onLog: appendFarmLog,
    });

    const blob = new Blob([result.data.slice().buffer], { type: preset.mime });
    outputURL = URL.createObjectURL(blob);
    outputVideo.src = outputURL;
    downloadOutput.href = outputURL;
    downloadOutput.download = result.outputName;
    resultMeta.textContent = `${formatBytes(blob.size)} · ${result.segmentCount} segments · ${formatDuration(result.elapsedMs)}`;
    resultPreview.classList.remove("is-hidden");
    jobState.textContent = "Complete";
    actionHint.textContent = "The output is ready to preview or download.";
    appendAppLog("system", `Finished ${result.outputName} in ${formatDuration(result.elapsedMs)}.`);
  } catch (error) {
    if (isAbortError(error)) {
      setProgress(0, "Export cancelled", "No output file was created.");
      jobState.textContent = "Cancelled";
      actionHint.textContent = "Settings are preserved. Start again when ready.";
      appendAppLog("system", "Export cancelled by the user.");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      showError(message);
      jobState.textContent = "Failed";
      stageLabel.textContent = "Export failed";
      stageDetail.textContent = "Open Activity for the latest FFmpeg messages.";
      appendAppLog("error", message);
    }
  } finally {
    abortController = undefined;
    stopElapsedTimer();
    setBusy(false);
  }
}

function cancelExport(): void {
  abortController?.abort(new DOMException("Cancelled by user", "AbortError"));
  cancelButton.disabled = true;
  cancelButton.textContent = "Cancelling…";
}

async function getCoreConfig(): Promise<{ coreURL: string; wasmURL: string }> {
  coreConfigPromise ??= Promise.all([
    toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
  ]).then(([coreURL, wasmURL]) => ({ coreURL, wasmURL }));
  try {
    return await coreConfigPromise;
  } catch (error) {
    coreConfigPromise = undefined;
    throw error;
  }
}

function updateProgress(event: FarmProgress): void {
  const percentage = Math.round(event.ratio * 100);
  const stage = STAGE_LABELS[event.stage];
  let detail = "Working locally in WebAssembly.";
  if (event.stage === "transcoding") {
    detail = `${event.completedSegments} of ${event.totalSegments} segments complete.`;
  } else if (event.stage === "splitting" && event.totalSegments > 0) {
    detail = `${event.totalSegments} keyframe-aligned segments prepared.`;
  } else if (event.stage === "loading-workers") {
    detail = `Starting ${lastWorkerCount} isolated FFmpeg instances.`;
  } else if (event.stage === "done") {
    detail = "The final container has been written.";
  }
  setProgress(event.ratio, stage, detail);
  jobState.textContent = event.stage === "done" ? "Complete" : "Running";
  activityStage.textContent = stage;
  activitySegments.textContent = `${event.completedSegments} / ${event.totalSegments}`;
  progressNumber.textContent = `${percentage}%`;
}

function setProgress(ratio: number, label: string, detail: string): void {
  const percentage = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  stageLabel.textContent = label;
  stageDetail.textContent = detail;
  progressNumber.textContent = `${percentage}%`;
  progressBar.style.width = `${percentage}%`;
  progressTrack.setAttribute("aria-valuenow", String(percentage));
}

function appendFarmLog(event: FarmLog): void {
  const scope = event.worker === undefined ? event.scope : `${event.scope} ${event.worker + 1}`;
  appendAppLog(scope, event.message);
}

function appendAppLog(scope: string, message: string): void {
  if (logEntries === 0) logView.replaceChildren();
  const row = document.createElement("div");
  row.className = "log-row";
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const source = document.createElement("span");
  source.className = "log-scope";
  source.textContent = scope;
  const copy = document.createElement("span");
  copy.className = "log-message";
  copy.textContent = message;
  row.append(time, source, copy);
  logView.append(row);
  logEntries += 1;
  while (logView.children.length > MAX_LOG_ROWS) logView.firstElementChild?.remove();
  logCount.textContent = `${logEntries} ${logEntries === 1 ? "entry" : "entries"}`;
  logView.scrollTop = logView.scrollHeight;
}

function clearLog(): void {
  logEntries = 0;
  logCount.textContent = "0 entries";
  const empty = document.createElement("div");
  empty.className = "log-empty";
  empty.textContent = "Logs will appear here after an export starts.";
  logView.replaceChildren(empty);
}

function setBusy(busy: boolean): void {
  const controls: Array<HTMLInputElement | HTMLSelectElement | HTMLButtonElement> = [
    fileInput,
    presetSelect,
    outputNameInput,
    workerInput,
    segmentInput,
    resetSettingsButton,
    clearFileButton,
  ];
  controls.forEach((control) => { control.disabled = busy; });
  startButton.classList.toggle("is-hidden", busy);
  cancelButton.classList.toggle("is-hidden", !busy);
  cancelButton.disabled = false;
  cancelButton.textContent = "Cancel";
  if (busy) {
    jobState.textContent = "Running";
    actionHint.textContent = "Keep this tab open until assembly finishes.";
  } else {
    startButton.disabled = !selectedFile;
  }
}

function showError(message: string): void {
  errorMessage.textContent = message;
  errorAlert.classList.remove("is-hidden");
}

function clearError(): void {
  errorAlert.classList.add("is-hidden");
  errorMessage.textContent = "";
}

function clearResult(): void {
  resultPreview.classList.add("is-hidden");
  outputVideo.removeAttribute("src");
  outputVideo.load();
  downloadOutput.removeAttribute("href");
  if (outputURL) URL.revokeObjectURL(outputURL);
  outputURL = undefined;
}

function startElapsedTimer(): void {
  stopElapsedTimer();
  elapsedTimer = window.setInterval(() => {
    activityElapsed.textContent = formatClock(performance.now() - startedAt);
  }, 500);
}

function stopElapsedTimer(): void {
  if (elapsedTimer !== undefined) window.clearInterval(elapsedTimer);
  elapsedTimer = undefined;
  if (startedAt > 0) activityElapsed.textContent = formatClock(performance.now() - startedAt);
}

function normalizeOutputName(value: string, extension: string): string {
  const leaf = (value.trim().split(/[\\/]/).at(-1) ?? "").replace(/\.[^.]+$/, "");
  let base = leaf.replace(/[^A-Za-z0-9._-]/g, "_") || "output";
  if (base === "." || base === "..") base = "output";
  if (base.startsWith("-")) base = `_${base}`;
  return `${base}.${extension}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}

function formatClock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}
