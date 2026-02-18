import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Store } from "@tauri-apps/plugin-store";

type UnsavedChoice = "save" | "dont_save" | "cancel";

type AiSettings = {
  endpoint: string;
  prompt: string;
};

type AiHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const appWindow = getCurrentWindow();
let settingsStore: Store | null = null;

function getRequiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

const editor = getRequiredElement<HTMLTextAreaElement>("#editor");
const statusBar = getRequiredElement<HTMLDivElement>("#status-bar");
const statusPosition =
  getRequiredElement<HTMLSpanElement>("#status-position");
const statusWrap = getRequiredElement<HTMLSpanElement>("#status-wrap");
const aiModal = getRequiredElement<HTMLDivElement>("#ai-modal");
const aiEndpoint = getRequiredElement<HTMLInputElement>("#ai-endpoint");
const aiKey = getRequiredElement<HTMLInputElement>("#ai-key");
const aiKeyStatus = getRequiredElement<HTMLSpanElement>("#ai-key-status");
const aiPrompt = getRequiredElement<HTMLTextAreaElement>("#ai-prompt");
const aiClose = getRequiredElement<HTMLButtonElement>("#ai-close");
const aiCancel = getRequiredElement<HTMLButtonElement>("#ai-cancel");
const aiSave = getRequiredElement<HTMLButtonElement>("#ai-save");
const aiClear = getRequiredElement<HTMLButtonElement>("#ai-clear");
const aiContextMenu = getRequiredElement<HTMLDivElement>("#ai-context-menu");
const busyOverlay = getRequiredElement<HTMLDivElement>("#busy-overlay");
const aiResultBar = getRequiredElement<HTMLDivElement>("#ai-result-bar");
const aiApply = getRequiredElement<HTMLButtonElement>("#ai-apply");
const aiKeepBoth = getRequiredElement<HTMLButtonElement>("#ai-keep-both");
const aiCopy = getRequiredElement<HTMLButtonElement>("#ai-copy");
const aiCancelResult = getRequiredElement<HTMLButtonElement>("#ai-cancel-result");

let currentFilePath: string | null = null;
let isDirty = false;
let wordWrapEnabled = true;
let statusBarVisible = true;
let hasStoredKey = false;
let lastSelection: { start: number; end: number } | null = null;
let lastSelectionText = "";
let docVersion = 0;
let suppressVersionBump = false;
let lastAiSnapshot: { text: string } | null = null;
let pendingAiResult: {
  text: string;
  beforeText: string;
  beforeDirty: boolean;
  selectionStart: number;
  selectionEnd: number;
  hadSelection: boolean;
  requestVersion: number;
} | null = null;

const defaultPrompt = "Make this clearer and more concise while preserving meaning.";
const quickActionPrompts: Record<string, string> = {
  rewrite: defaultPrompt,
  improve: "Improve clarity and flow while preserving meaning.",
  shorten: "Shorten the text while keeping the key points.",
  expand: "Expand the text with more detail while preserving meaning.",
  simplify: "Simplify the text for easier understanding.",
  "fix-grammar": "Fix grammar, spelling, and punctuation without changing meaning.",
};
const useCasePrompts: Record<string, string> = {
  proposal: "Write a clear, concise proposal based on the text.",
  "task-plan": "Create a task plan with steps, owners if known, and timeline.",
  email: "Write a professional email based on the text.",
};
const aiContextButtons = Array.from(
  aiContextMenu.querySelectorAll<HTMLButtonElement>("button[data-action]"),
);

function getFileName(path: string | null) {
  if (!path) return "Untitled";
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "Untitled";
}

function updateWindowTitle() {
  const name = getFileName(currentFilePath);
  const dirtyMark = isDirty ? "*" : "";
  void appWindow.setTitle(`${dirtyMark}${name} - NotepadAI`).catch((error) => {
    console.error("setTitle failed:", error);
  });
}

function setDirtyState(nextDirty: boolean) {
  isDirty = nextDirty;
  updateWindowTitle();
}

function setWordWrap(next: boolean) {
  wordWrapEnabled = next;
  editor.classList.toggle("no-wrap", !wordWrapEnabled);
  editor.setAttribute("wrap", wordWrapEnabled ? "soft" : "off");
  statusWrap.textContent = `Word Wrap: ${wordWrapEnabled ? "On" : "Off"}`;
}

function toggleWordWrap() {
  setWordWrap(!wordWrapEnabled);
}

function setStatusBarVisible(next: boolean) {
  statusBarVisible = next;
  statusBar.classList.toggle("hidden", !statusBarVisible);
}

function updateCursorStatus() {
  const textBeforeCursor = editor.value.slice(0, editor.selectionStart || 0);
  const lines = textBeforeCursor.split("\n");
  const lineNumber = lines.length || 1;
  const columnNumber = (lines[lines.length - 1] || "").length + 1;
  statusPosition.textContent = `Ln ${lineNumber}, Col ${columnNumber}`;
}

function getQuickActionPrompt(action: string): string | null {
  return quickActionPrompts[action] || null;
}

function runAiQuickAction(action: string) {
  const promptOverride = getQuickActionPrompt(action);
  if (!promptOverride) return;
  void runAiRewrite(promptOverride);
}

function runAiUseCase(action: string) {
  const promptOverride = useCasePrompts[action];
  if (!promptOverride) return;
  void runAiRewrite(promptOverride);
}

async function ensureStore(): Promise<Store> {
  if (settingsStore) return settingsStore;
  settingsStore = await Store.load("settings.json");
  return settingsStore;
}

async function getAiSettings(): Promise<AiSettings> {
  const store = await ensureStore();
  const endpoint = ((await store.get("apiEndpoint")) as string) || "";
  const prompt = ((await store.get("customPrompt")) as string) || "";
  return { endpoint, prompt };
}

async function loadAiSettings() {
  console.log("AI settings: load");
  const { endpoint, prompt } = await getAiSettings();
  aiEndpoint.value = endpoint;
  aiPrompt.value = prompt || defaultPrompt;

  let storedKey = "";
  try {
    storedKey = (await invoke<string | null>("get_api_key")) || "";
  } catch {
    storedKey = "";
  }
  hasStoredKey = storedKey.length > 0;
  aiKeyStatus.textContent = hasStoredKey
    ? "API key stored securely."
    : "No key stored.";
  aiKey.value = "";
}

async function saveAiSettings() {
  const store = await ensureStore();
  await store.set("apiEndpoint", aiEndpoint.value.trim());
  await store.set("customPrompt", aiPrompt.value.trim());
  await store.save();

  const key = aiKey.value.trim();
  if (key) {
    await invoke("set_api_key", { key });
    hasStoredKey = true;
  }

  aiKeyStatus.textContent = hasStoredKey
    ? "API key stored securely."
    : "No key stored.";
}

async function clearAiKey() {
  await invoke("delete_api_key");
  hasStoredKey = false;
  aiKeyStatus.textContent = "No key stored.";
  aiKey.value = "";
}

function openAiModal() {
  console.log("AI settings: open modal");
  aiModal.classList.add("open");
  aiModal.setAttribute("aria-hidden", "false");
}

function closeAiModal() {
  aiModal.classList.remove("open");
  aiModal.setAttribute("aria-hidden", "true");
}

async function confirmUnsavedChanges(): Promise<UnsavedChoice> {
  return invoke<UnsavedChoice>("confirm_unsaved_changes", {
    filename: getFileName(currentFilePath),
  });
}

async function ensureSavedIfDirty(): Promise<boolean> {
  if (!isDirty) return true;
  const choice = await confirmUnsavedChanges();
  if (choice === "cancel") return false;
  if (choice === "save") {
    return saveFile();
  }
  return true;
}

async function newFile() {
  if (!(await ensureSavedIfDirty())) return;
  editor.value = "";
  currentFilePath = null;
  setDirtyState(false);
  updateCursorStatus();
}

async function openFile() {
  if (!(await ensureSavedIfDirty())) return;
  const selected = await open({
    multiple: false,
    title: "Open File",
  });
  console.log("open dialog selection:", selected);
  if (!selected || Array.isArray(selected)) return;
  const contents = await readTextFile(selected);
  editor.value = contents;
  currentFilePath = selected;
  setDirtyState(false);
  updateCursorStatus();
}

async function saveFile(saveAs = false): Promise<boolean> {
  let targetPath = currentFilePath;
  if (!targetPath || saveAs) {
    const selected = await save({
      title: "Save File",
      defaultPath: targetPath || undefined,
    });
    console.log("save dialog selection:", selected);
    if (!selected) return false;
    targetPath = selected;
  }
  try {
    console.log("writing file:", targetPath);
    await writeTextFile(targetPath, editor.value);
    currentFilePath = targetPath;
    setDirtyState(false);
    return true;
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "Unable to save file.";
    await message(messageText, {
      title: "NotepadAI",
      kind: "error",
    });
    return false;
  }
}

async function exitApp() {
  if (!(await ensureSavedIfDirty())) return;
  await appWindow.close();
}

function execEditorCommand(command: string) {
  editor.focus();
  document.execCommand(command);
}

function setBusyState(active: boolean) {
  busyOverlay.classList.toggle("visible", active);
  busyOverlay.setAttribute("aria-hidden", active ? "false" : "true");
  editor.disabled = active;
  for (const button of aiContextButtons) {
    button.disabled = active;
  }
}

function getSelectionText() {
  const start = editor.selectionStart || 0;
  const end = editor.selectionEnd || 0;
  if (end > start) return editor.value.slice(start, end);
  return "";
}

function closeAiContextMenu() {
  aiContextMenu.classList.remove("open");
  aiContextMenu.setAttribute("aria-hidden", "true");
}

function openAiContextMenu(x: number, y: number) {
  aiContextMenu.classList.add("open");
  aiContextMenu.setAttribute("aria-hidden", "false");
  const padding = 8;
  const rect = aiContextMenu.getBoundingClientRect();
  const left = Math.min(
    Math.max(padding, x),
    window.innerWidth - rect.width - padding,
  );
  const top = Math.min(
    Math.max(padding, y),
    window.innerHeight - rect.height - padding,
  );
  aiContextMenu.style.left = `${left}px`;
  aiContextMenu.style.top = `${top}px`;
}

function triggerQuickAction(action: string) {
  const promptOverride = getQuickActionPrompt(action);
  if (!promptOverride) return;
  if (!lastSelectionText.trim()) return;
  const selectionOverride = lastSelection
    ? {
        start: lastSelection.start,
        end: lastSelection.end,
        text: lastSelectionText,
      }
    : undefined;
  closeAiContextMenu();
  void runAiRewrite(promptOverride, selectionOverride);
}

function replaceSelection(text: string) {
  const start = editor.selectionStart || 0;
  const end = editor.selectionEnd || 0;
  editor.setRangeText(text, start, end, "select");
}

function replaceSelectionRange(text: string, start: number, end: number) {
  editor.setRangeText(text, start, end, "select");
}

function applyPreviewText(text: string, selection: { start: number; end: number }) {
  suppressVersionBump = true;
  replaceSelectionRange(text, selection.start, selection.end);
}

function applyPreviewAll(text: string) {
  suppressVersionBump = true;
  replaceAll(text);
}

function showAiResultBar() {
  aiResultBar.classList.add("open");
  aiResultBar.setAttribute("aria-hidden", "false");
}

function hideAiResultBar() {
  aiResultBar.classList.remove("open");
  aiResultBar.setAttribute("aria-hidden", "true");
  pendingAiResult = null;
}

function replaceAll(text: string) {
  editor.value = text;
  editor.selectionStart = editor.value.length;
  editor.selectionEnd = editor.value.length;
}

function extractAiText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const data = payload as Record<string, unknown>;
  if (typeof data.text === "string") return data.text;
  if (typeof data.output === "string") return data.output;
  if (typeof data.result === "string") return data.result;
  if (typeof data.response === "string") return data.response;
  const choices = data.choices as unknown[] | undefined;
  if (choices && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") return message.content;
    if (typeof first.text === "string") return first.text;
  }
  return "";
}

async function parseAiResponse(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const parsed = (await response.json()) as unknown;
    return extractAiText(parsed);
  }

  const raw = await response.text();
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  const lastLine = lines[lines.length - 1];
  try {
    const parsed = JSON.parse(lastLine) as unknown;
    return extractAiText(parsed);
  } catch {
    return raw.trim();
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === "string") return maybeMessage;
    const maybeError = (error as { error?: unknown }).error;
    if (typeof maybeError === "string") return maybeError;
  }
  return "Unknown error.";
}

async function runAiRewrite(
  promptOverride?: string,
  selectionOverride?: { start: number; end: number; text: string },
) {
  if (pendingAiResult) {
    suppressVersionBump = true;
    replaceAll(pendingAiResult.beforeText);
    setDirtyState(pendingAiResult.beforeDirty);
    hideAiResultBar();
  }
  const { endpoint, prompt } = await getAiSettings();
  const key = (await invoke<string | null>("get_api_key")) || "";
  if (!endpoint) {
    await message("Set your API endpoint in AI Settings first.", {
      title: "NotepadAI",
      kind: "warning",
    });
    return;
  }

  console.log("AI rewrite: endpoint", endpoint);

  const selectionText = selectionOverride?.text || getSelectionText();
  const input = selectionText || editor.value;
  if (!input.trim()) {
    await message("There is no text to rewrite.", {
      title: "NotepadAI",
      kind: "info",
    });
    return;
  }
  let endpointUrl: URL | null = null;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    await message("Invalid API endpoint URL.", {
      title: "NotepadAI",
      kind: "error",
    });
    return;
  }

  const isOllama = endpointUrl.pathname.endsWith("/api/generate");
  console.log("AI rewrite: isOllama", isOllama);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }

  const selectedPrompt = (promptOverride || prompt || defaultPrompt).trim();
  const combinedPrompt = selectedPrompt ? `${selectedPrompt}\n\n${input}` : input;
  const body = isOllama
    ? {
        model: endpointUrl.searchParams.get("model") || "",
        prompt: combinedPrompt,
        stream: false,
      }
    : { text: input, prompt: selectedPrompt };

  if (isOllama && !body.model) {
    await message(
      "Ollama requires a model name. Add ?model=llama3 (or your model) to the endpoint.",
      {
        title: "NotepadAI",
        kind: "warning",
      },
    );
    return;
  }

  console.log("AI rewrite: request body", body);
  setBusyState(true);
  try {
    const responseData = await invoke<AiHttpResponse>("ai_request", {
      request: {
        endpoint,
        headers,
        body,
      },
    });
    const response = new Response(responseData.body, {
      status: responseData.status,
      headers: responseData.headers,
    });

    console.log("AI rewrite: response status", response.status);
    if (response.status === 401) {
      throw new Error("Unauthorized (401). Check your API key.");
    }

    if (!response.ok) {
      throw new Error(`Network error (${response.status}).`);
    }

    const output = await parseAiResponse(response);
    console.log("AI rewrite: output length", output.length);
    if (!output.trim()) {
      throw new Error("Empty response from AI service.");
    }

    const start = selectionOverride?.start ?? (editor.selectionStart || 0);
    const end = selectionOverride?.end ?? (editor.selectionEnd || 0);
    pendingAiResult = {
      text: output,
      beforeText: editor.value,
      beforeDirty: isDirty,
      selectionStart: start,
      selectionEnd: end,
      hadSelection: Boolean(selectionText),
      requestVersion: docVersion,
    };
    if (pendingAiResult.hadSelection) {
      applyPreviewText(output, { start, end });
    } else {
      applyPreviewAll(output);
    }
    setDirtyState(true);
    showAiResultBar();
  } catch (error) {
    const messageText = getErrorMessage(error);
    await message(messageText, {
      title: "NotepadAI",
      kind: "error",
    });
  } finally {
    setBusyState(false);
  }
}

function showAbout() {
  void message("NotepadAI\nClassic notepad with an AI rewrite helper.", {
    title: "About",
    kind: "info",
  });
}

async function handleMenuEvent(id: string) {
  console.log("handleMenuEvent:", id);
  switch (id) {
    case "file_new":
      await newFile();
      break;
    case "file_open":
      await openFile();
      break;
    case "file_save":
      await saveFile();
      break;
    case "file_save_as":
      await saveFile(true);
      break;
    case "file_exit":
      await exitApp();
      break;
    case "edit_undo":
      execEditorCommand("undo");
      break;
    case "edit_undo_ai":
      if (lastAiSnapshot) {
        replaceAll(lastAiSnapshot.text);
        setDirtyState(true);
      }
      break;
    case "edit_cut":
      execEditorCommand("cut");
      break;
    case "edit_copy":
      execEditorCommand("copy");
      break;
    case "edit_paste":
      execEditorCommand("paste");
      break;
    case "edit_select_all":
      editor.select();
      break;
    case "format_word_wrap":
      toggleWordWrap();
      break;
    case "view_status_bar":
      setStatusBarVisible(!statusBarVisible);
      break;
    case "help_about":
      showAbout();
      break;
    case "ai_rewrite":
      await runAiRewrite();
      break;
    case "ai_improve":
      runAiQuickAction("improve");
      break;
    case "ai_shorten":
      runAiQuickAction("shorten");
      break;
    case "ai_expand":
      runAiQuickAction("expand");
      break;
    case "ai_simplify":
      runAiQuickAction("simplify");
      break;
    case "ai_fix_grammar":
      runAiQuickAction("fix-grammar");
      break;
    case "use_case_proposal":
      runAiUseCase("proposal");
      break;
    case "use_case_task_plan":
      runAiUseCase("task-plan");
      break;
    case "use_case_email":
      runAiUseCase("email");
      break;
    case "ai_settings":
      openAiModal();
      try {
        await loadAiSettings();
      } catch (error) {
        const messageText =
          error instanceof Error ? error.message : "Unable to load AI settings.";
        await message(messageText, {
          title: "NotepadAI",
          kind: "error",
        });
      }
      break;
    default:
      break;
  }
}

async function init() {
  window.addEventListener("error", (event) => {
    console.error("window error:", event.error || event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("unhandled rejection:", event.reason);
  });

  try {
    await ensureStore();
  } catch (error) {
    console.error("settings store init failed:", error);
  }
  updateWindowTitle();
  updateCursorStatus();
  setWordWrap(true);
  setStatusBarVisible(true);

  editor.addEventListener("input", () => {
    if (!isDirty) setDirtyState(true);
    if (suppressVersionBump) {
      suppressVersionBump = false;
    } else {
      docVersion += 1;
    }
    updateCursorStatus();
  });
  editor.addEventListener("click", updateCursorStatus);
  editor.addEventListener("keyup", updateCursorStatus);
  editor.addEventListener("select", updateCursorStatus);
  editor.addEventListener("mouseup", updateCursorStatus);
  editor.addEventListener("focus", updateCursorStatus);
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === editor) updateCursorStatus();
  });
  statusWrap.addEventListener("click", () => {
    toggleWordWrap();
  });
  editor.addEventListener("contextmenu", (event) => {
    if (editor.disabled) return;
    const selection = getSelectionText();
    if (!selection.trim()) {
      closeAiContextMenu();
      return;
    }
    event.preventDefault();
    lastSelection = {
      start: editor.selectionStart || 0,
      end: editor.selectionEnd || 0,
    };
    lastSelectionText = selection;
    editor.focus();
    editor.selectionStart = lastSelection.start;
    editor.selectionEnd = lastSelection.end;
    openAiContextMenu(event.clientX, event.clientY);
  });
  editor.addEventListener("scroll", closeAiContextMenu);
  editor.addEventListener("blur", closeAiContextMenu);
  window.addEventListener("resize", closeAiContextMenu);
  document.addEventListener("click", (event) => {
    if (!aiContextMenu.classList.contains("open")) return;
    if (aiContextMenu.contains(event.target as Node)) return;
    closeAiContextMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAiContextMenu();
  });
  aiContextMenu.addEventListener("pointerdown", (event) => {
    const target = (event.target as HTMLElement).closest(
      "button[data-action]",
    ) as HTMLButtonElement | null;
    if (!target) return;
    event.preventDefault();
    const action = target.dataset.action;
    if (action) triggerQuickAction(action);
  });

  aiApply.addEventListener("click", () => {
    if (!pendingAiResult) return;
    if (pendingAiResult.requestVersion !== docVersion) {
      const proceed = window.confirm("Document changed. Apply anyway?");
      if (!proceed) return;
    }
    lastAiSnapshot = { text: pendingAiResult.beforeText };
    setDirtyState(true);
    hideAiResultBar();
  });

  aiKeepBoth.addEventListener("click", () => {
    if (!pendingAiResult) return;
    if (pendingAiResult.requestVersion !== docVersion) {
      const proceed = window.confirm("Document changed. Apply anyway?");
      if (!proceed) return;
    }
    lastAiSnapshot = { text: pendingAiResult.beforeText };
    suppressVersionBump = true;
    replaceAll(pendingAiResult.beforeText);
    if (pendingAiResult.hadSelection) {
      const insert = `\n${pendingAiResult.text}`;
      replaceSelectionRange(
        insert,
        pendingAiResult.selectionEnd,
        pendingAiResult.selectionEnd,
      );
    } else {
      const spacer = editor.value.endsWith("\n") ? "" : "\n";
      replaceAll(`${editor.value}${spacer}${pendingAiResult.text}`);
    }
    setDirtyState(true);
    hideAiResultBar();
  });

  aiCopy.addEventListener("click", async () => {
    if (!pendingAiResult) return;
    try {
      await navigator.clipboard.writeText(pendingAiResult.text);
      suppressVersionBump = true;
      replaceAll(pendingAiResult.beforeText);
      setDirtyState(pendingAiResult.beforeDirty);
      hideAiResultBar();
    } catch (error) {
      const messageText = getErrorMessage(error);
      await message(messageText, {
        title: "NotepadAI",
        kind: "error",
      });
    }
  });

  aiCancelResult.addEventListener("click", () => {
    if (pendingAiResult) {
      suppressVersionBump = true;
      replaceAll(pendingAiResult.beforeText);
      setDirtyState(pendingAiResult.beforeDirty);
    }
    hideAiResultBar();
  });

  aiClose.addEventListener("click", closeAiModal);
  aiCancel.addEventListener("click", closeAiModal);
  aiClear.addEventListener("click", async () => {
    await clearAiKey();
  });
  aiSave.addEventListener("click", async () => {
    await saveAiSettings();
    closeAiModal();
  });

  aiModal.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target?.dataset.close === "true") closeAiModal();
  });

  await listen<string>("menu-event", (event) => {
    console.log("app event menu-event:", event.payload);
    void handleMenuEvent(event.payload);
  });
}

void init();
