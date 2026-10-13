import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message, open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { Store } from "@tauri-apps/plugin-store";

import { describeHttpError } from "./providers/errors";
import { cleanAiResponseText } from "./responseFormatter";
import { sendHttpRequest, startStream, type StreamHandle } from "./providers/httpClient";
import { PROVIDER_ORDER, getProviderDefinition, resolveEffectiveConfig } from "./providers/registry";
import type { ProviderConfig, ProviderId } from "./providers/types";
import {
  DEFAULT_PROMPT,
  deleteProviderApiKey,
  defaultSettings,
  getProviderApiKey,
  hostOf,
  loadSettings,
  migrateLegacyApiKey,
  needsHostTrustWarning,
  saveSettings,
  setProviderApiKey,
  type AppSettings,
  type CustomUseCase,
} from "./settings";

type UnsavedChoice = "save" | "dont_save" | "cancel";

const appWindow = getCurrentWindow();
let settingsStore: Store | null = null;
let appSettings: AppSettings = defaultSettings();

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
const aiProviderSelect = getRequiredElement<HTMLSelectElement>("#ai-provider");
const aiBaseUrl = getRequiredElement<HTMLInputElement>("#ai-base-url");
const aiBaseUrlHint = getRequiredElement<HTMLSpanElement>("#ai-base-url-hint");
const aiModelInput = getRequiredElement<HTMLInputElement>("#ai-model");
const aiModelList = getRequiredElement<HTMLDataListElement>("#ai-model-list");
const aiFetchModels = getRequiredElement<HTMLButtonElement>("#ai-fetch-models");
const aiModelStatus = getRequiredElement<HTMLSpanElement>("#ai-model-status");
const aiOrgProjectFields = getRequiredElement<HTMLDivElement>("#ai-org-project");
const aiOrganization = getRequiredElement<HTMLInputElement>("#ai-organization");
const aiProject = getRequiredElement<HTMLInputElement>("#ai-project");
const aiKey = getRequiredElement<HTMLInputElement>("#ai-key");
const aiKeyStatus = getRequiredElement<HTMLSpanElement>("#ai-key-status");
const aiTrustWarning = getRequiredElement<HTMLDivElement>("#ai-trust-warning");
const aiTrustWarningText = getRequiredElement<HTMLSpanElement>("#ai-trust-warning-text");
const aiTrustAccept = getRequiredElement<HTMLButtonElement>("#ai-trust-accept");
const aiTestConnection = getRequiredElement<HTMLButtonElement>("#ai-test-connection");
const aiTestStatus = getRequiredElement<HTMLSpanElement>("#ai-test-status");
const aiPrompt = getRequiredElement<HTMLTextAreaElement>("#ai-prompt");
const aiClose = getRequiredElement<HTMLButtonElement>("#ai-close");
const aiCancel = getRequiredElement<HTMLButtonElement>("#ai-cancel");
const aiSave = getRequiredElement<HTMLButtonElement>("#ai-save");
const aiClear = getRequiredElement<HTMLButtonElement>("#ai-clear");
const aiContextMenu = getRequiredElement<HTMLDivElement>("#ai-context-menu");
const aiCustomInstructionForm = getRequiredElement<HTMLFormElement>("#ai-custom-instruction-form");
const aiCustomInstructionInput = getRequiredElement<HTMLInputElement>("#ai-custom-instruction");
const aiContextMenuCustom = getRequiredElement<HTMLDivElement>("#ai-context-menu-custom");
const aiUseCaseList = getRequiredElement<HTMLDivElement>("#ai-use-case-list");
const aiUseCaseLabelInput = getRequiredElement<HTMLInputElement>("#ai-use-case-label");
const aiUseCasePromptInput = getRequiredElement<HTMLInputElement>("#ai-use-case-prompt");
const aiUseCaseAdd = getRequiredElement<HTMLButtonElement>("#ai-use-case-add");
const busyOverlay = getRequiredElement<HTMLDivElement>("#busy-overlay");
const busyOverlayText = getRequiredElement<HTMLDivElement>("#busy-overlay-text");
const aiStreamStatus = getRequiredElement<HTMLDivElement>("#ai-stream-status");
const aiStreamStatusText = getRequiredElement<HTMLSpanElement>("#ai-stream-status-text");
const aiStreamStop = getRequiredElement<HTMLButtonElement>("#ai-stream-stop");
const aiResultBar = getRequiredElement<HTMLDivElement>("#ai-result-bar");
const aiApply = getRequiredElement<HTMLButtonElement>("#ai-apply");
const aiKeepBoth = getRequiredElement<HTMLButtonElement>("#ai-keep-both");
const aiCopy = getRequiredElement<HTMLButtonElement>("#ai-copy");
const aiCancelResult = getRequiredElement<HTMLButtonElement>("#ai-cancel-result");

let currentFilePath: string | null = null;
let isDirty = false;
let wordWrapEnabled = true;
let statusBarVisible = true;
let lastSelection: { start: number; end: number } | null = null;
let lastSelectionText = "";
let docVersion = 0;
let suppressVersionBump = false;
let lastAiSnapshot: { text: string } | null = null;
let activeStreamHandle: StreamHandle | null = null;
let pendingTrustAction: (() => Promise<void>) | null = null;
let pendingAiResult: {
  text: string;
  beforeText: string;
  beforeDirty: boolean;
  selectionStart: number;
  selectionEnd: number;
  hadSelection: boolean;
  requestVersion: number;
} | null = null;

const quickActionPrompts: Record<string, string> = {
  rewrite: DEFAULT_PROMPT,
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

async function ensureAppSettingsLoaded(): Promise<AppSettings> {
  const store = await ensureStore();
  appSettings = await loadSettings({ store, migrateLegacyApiKey });
  return appSettings;
}

async function persistAppSettings(): Promise<void> {
  const store = await ensureStore();
  await saveSettings(store, appSettings);
}

/** Renders the right-click menu's list of user-defined use cases (below the built-in quick actions). */
function renderCustomUseCaseContextButtons() {
  aiContextMenuCustom.innerHTML = "";
  if (appSettings.customUseCases.length === 0) return;
  const separator = document.createElement("div");
  separator.className = "ai-context-menu-separator";
  aiContextMenuCustom.appendChild(separator);
  for (const useCase of appSettings.customUseCases) {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.dataset.customUseCaseId = useCase.id;
    button.textContent = useCase.label;
    aiContextMenuCustom.appendChild(button);
  }
}

/** Renders the manage-list in AI Settings (label + Remove button per custom use case). */
function renderUseCaseManagerList() {
  aiUseCaseList.innerHTML = "";
  for (const useCase of appSettings.customUseCases) {
    const row = document.createElement("div");
    row.className = "use-case-row";
    const label = document.createElement("span");
    label.className = "use-case-label";
    label.textContent = useCase.label;
    label.title = useCase.prompt;
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "ghost";
    removeButton.textContent = "Remove";
    removeButton.dataset.id = useCase.id;
    row.appendChild(label);
    row.appendChild(removeButton);
    aiUseCaseList.appendChild(row);
  }
}

async function addCustomUseCase() {
  const label = aiUseCaseLabelInput.value.trim();
  const prompt = aiUseCasePromptInput.value.trim();
  if (!label || !prompt) return;
  const useCase: CustomUseCase = { id: crypto.randomUUID(), label, prompt };
  appSettings.customUseCases = [...appSettings.customUseCases, useCase];
  aiUseCaseLabelInput.value = "";
  aiUseCasePromptInput.value = "";
  await persistAppSettings();
  renderUseCaseManagerList();
  renderCustomUseCaseContextButtons();
}

async function removeCustomUseCase(id: string) {
  appSettings.customUseCases = appSettings.customUseCases.filter((useCase) => useCase.id !== id);
  await persistAppSettings();
  renderUseCaseManagerList();
  renderCustomUseCaseContextButtons();
}

function populateProviderSelect() {
  aiProviderSelect.innerHTML = "";
  const localGroup = document.createElement("optgroup");
  localGroup.label = "Local / Self-hosted";
  const cloudGroup = document.createElement("optgroup");
  cloudGroup.label = "Cloud";
  for (const id of PROVIDER_ORDER) {
    const def = getProviderDefinition(id);
    const option = document.createElement("option");
    option.value = id;
    option.textContent = def.label;
    (def.category === "local" ? localGroup : cloudGroup).appendChild(option);
  }
  aiProviderSelect.appendChild(localGroup);
  aiProviderSelect.appendChild(cloudGroup);
}

function hideTrustWarning() {
  aiTrustWarning.hidden = true;
  pendingTrustAction = null;
}

function showTrustWarning(host: string, onAccept: () => Promise<void>) {
  aiTrustWarningText.textContent = `You're about to send your API key to "${host}". Only continue if you trust this endpoint.`;
  aiTrustWarning.hidden = false;
  pendingTrustAction = onAccept;
}

async function onProviderSelectionChanged() {
  const providerId = aiProviderSelect.value as ProviderId;
  const def = getProviderDefinition(providerId);
  const config = appSettings.providers[providerId] || { model: "" };

  aiBaseUrl.value = config.baseUrl || def.defaultBaseUrl || "";
  aiBaseUrl.readOnly = !def.baseUrlEditable;
  aiBaseUrl.placeholder = def.defaultBaseUrl || "https://...";
  aiBaseUrlHint.textContent = def.baseUrlEditable
    ? "Point this at your server's address."
    : "Fixed by the provider.";

  aiModelInput.value = config.model || "";
  aiModelInput.placeholder = def.modelPlaceholder;
  aiModelList.innerHTML = "";
  aiModelStatus.textContent = "";
  aiFetchModels.disabled = !def.adapter.supportsModelList;
  aiFetchModels.title = def.adapter.supportsModelList
    ? ""
    : "This provider has no official model-list endpoint.";

  aiOrgProjectFields.hidden = !def.supportsOrgProject;
  aiOrganization.value = config.organization || "";
  aiProject.value = config.project || "";

  aiKey.value = "";
  let storedKey: string | null = null;
  try {
    storedKey = await getProviderApiKey(providerId);
  } catch {
    storedKey = null;
  }
  aiKeyStatus.textContent = storedKey
    ? "API key stored securely."
    : def.requiresApiKey
      ? "No key stored (required)."
      : "No key stored.";

  hideTrustWarning();
  aiTestStatus.textContent = "";
}

async function loadAiSettings() {
  aiProviderSelect.value = appSettings.activeProviderId;
  await onProviderSelectionChanged();
  aiPrompt.value = appSettings.customPrompt || DEFAULT_PROMPT;
  renderUseCaseManagerList();
}

function readDraftConfig(def: ReturnType<typeof getProviderDefinition>): ProviderConfig {
  return {
    model: aiModelInput.value.trim(),
    baseUrl: def.baseUrlEditable ? aiBaseUrl.value.trim() || undefined : undefined,
    organization: def.supportsOrgProject ? aiOrganization.value.trim() || undefined : undefined,
    project: def.supportsOrgProject ? aiProject.value.trim() || undefined : undefined,
  };
}

async function saveAiSettings() {
  const providerId = aiProviderSelect.value as ProviderId;
  const def = getProviderDefinition(providerId);
  const draftConfig = readDraftConfig(def);

  const keyInput = aiKey.value.trim();
  const willHaveKey = Boolean(keyInput) || Boolean(await getProviderApiKey(providerId));

  if (def.baseUrlEditable) {
    const effective = resolveEffectiveConfig(providerId, draftConfig);
    if (effective.baseUrl && needsHostTrustWarning(effective.baseUrl, willHaveKey, appSettings.trustedHosts)) {
      const host = hostOf(effective.baseUrl);
      if (host) {
        showTrustWarning(host, async () => {
          appSettings.trustedHosts = [...appSettings.trustedHosts, host];
          await saveAiSettings();
        });
        return;
      }
    }
  }

  appSettings.providers[providerId] = draftConfig;
  appSettings.activeProviderId = providerId;
  appSettings.customPrompt = aiPrompt.value.trim();

  await persistAppSettings();

  if (keyInput) {
    await setProviderApiKey(providerId, keyInput);
  }

  closeAiModal();
}

async function clearAiKey() {
  const providerId = aiProviderSelect.value as ProviderId;
  await deleteProviderApiKey(providerId);
  aiKey.value = "";
  const def = getProviderDefinition(providerId);
  aiKeyStatus.textContent = def.requiresApiKey ? "No key stored (required)." : "No key stored.";
}

async function runTestConnection() {
  const providerId = aiProviderSelect.value as ProviderId;
  const def = getProviderDefinition(providerId);
  const draftConfig = readDraftConfig(def);
  const effective = resolveEffectiveConfig(providerId, draftConfig);

  if (!effective.baseUrl) {
    aiTestStatus.textContent = "Set a base URL first.";
    return;
  }

  const keyInput = aiKey.value.trim();
  const apiKey = keyInput || (await getProviderApiKey(providerId));
  if (def.requiresApiKey && !apiKey) {
    aiTestStatus.textContent = "Add an API key first.";
    return;
  }

  if (def.baseUrlEditable && needsHostTrustWarning(effective.baseUrl, Boolean(apiKey), appSettings.trustedHosts)) {
    const host = hostOf(effective.baseUrl);
    if (host) {
      showTrustWarning(host, async () => {
        appSettings.trustedHosts = [...appSettings.trustedHosts, host];
        await runTestConnection();
      });
      return;
    }
  }

  aiTestStatus.textContent = "";
  aiTestConnection.disabled = true;
  setBusyState(true, "Testing connection…");
  try {
    if (def.adapter.supportsModelList) {
      const request = def.adapter.buildModelListRequest!(effective, apiKey);
      const result = await sendHttpRequest(request);
      if (result.status < 200 || result.status >= 300) {
        throw new Error(describeHttpError(result.status, result.body));
      }
      const models = def.adapter.parseModelListResponse!(result.body);
      aiTestStatus.textContent = `Connected. ${models.length} model${models.length === 1 ? "" : "s"} available.`;
    } else {
      if (!effective.model.trim()) {
        aiTestStatus.textContent = "Enter a model id first.";
        return;
      }
      const request = def.adapter.buildChatRequest(effective, apiKey, "Reply with OK.", false);
      const result = await sendHttpRequest(request);
      def.adapter.parseNonStreamResponse(result.status, result.body);
      aiTestStatus.textContent = "Connected. (This provider has no model-list endpoint, so this was a minimal real request.)";
    }
  } catch (error) {
    aiTestStatus.textContent = getErrorMessage(error);
  } finally {
    setBusyState(false);
    aiTestConnection.disabled = false;
  }
}

async function runFetchModels() {
  const providerId = aiProviderSelect.value as ProviderId;
  const def = getProviderDefinition(providerId);
  if (!def.adapter.supportsModelList) {
    aiModelStatus.textContent = "This provider has no model-list endpoint. Enter the model id manually.";
    return;
  }

  const draftConfig = readDraftConfig(def);
  const effective = resolveEffectiveConfig(providerId, draftConfig);
  if (!effective.baseUrl) {
    aiModelStatus.textContent = "Set a base URL first.";
    return;
  }

  const keyInput = aiKey.value.trim();
  const apiKey = keyInput || (await getProviderApiKey(providerId));
  if (def.requiresApiKey && !apiKey) {
    aiModelStatus.textContent = "Add an API key first.";
    return;
  }

  if (def.baseUrlEditable && needsHostTrustWarning(effective.baseUrl, Boolean(apiKey), appSettings.trustedHosts)) {
    const host = hostOf(effective.baseUrl);
    if (host) {
      showTrustWarning(host, async () => {
        appSettings.trustedHosts = [...appSettings.trustedHosts, host];
        await runFetchModels();
      });
      return;
    }
  }

  aiModelStatus.textContent = "";
  aiFetchModels.disabled = true;
  setBusyState(true, "Fetching models…");
  try {
    const request = def.adapter.buildModelListRequest!(effective, apiKey);
    const result = await sendHttpRequest(request);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(describeHttpError(result.status, result.body));
    }
    const models = def.adapter.parseModelListResponse!(result.body);
    aiModelList.innerHTML = "";
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      aiModelList.appendChild(option);
    }
    aiModelStatus.textContent = models.length ? `Found ${models.length} models.` : "No models returned.";
  } catch (error) {
    aiModelStatus.textContent = getErrorMessage(error);
  } finally {
    setBusyState(false);
    aiFetchModels.disabled = !def.adapter.supportsModelList;
  }
}

function openAiModal() {
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
    if (!selected) return false;
    targetPath = selected;
  }
  try {
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

function setBusyState(active: boolean, text = "Working…") {
  busyOverlayText.textContent = text;
  busyOverlay.classList.toggle("visible", active);
  busyOverlay.setAttribute("aria-hidden", active ? "false" : "true");
}

function setGeneratingState(active: boolean) {
  editor.disabled = active;
  for (const button of aiContextButtons) {
    button.disabled = active;
  }
  aiStreamStatusText.textContent = "Generating…";
  aiStreamStatus.classList.toggle("open", active);
  aiStreamStatus.setAttribute("aria-hidden", active ? "false" : "true");
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

function runOnLastSelection(promptOverride: string) {
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

function triggerQuickAction(action: string) {
  const promptOverride = getQuickActionPrompt(action);
  if (!promptOverride) return;
  runOnLastSelection(promptOverride);
}

function triggerCustomInstruction(instruction: string) {
  runOnLastSelection(instruction);
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
  if (activeStreamHandle) return;

  if (pendingAiResult) {
    suppressVersionBump = true;
    replaceAll(pendingAiResult.beforeText);
    setDirtyState(pendingAiResult.beforeDirty);
    hideAiResultBar();
  }

  const providerId = appSettings.activeProviderId;
  const def = getProviderDefinition(providerId);
  const storedConfig = appSettings.providers[providerId] || { model: "" };
  const effectiveConfig = resolveEffectiveConfig(providerId, storedConfig);

  if (!effectiveConfig.baseUrl) {
    await message(`Set a base URL for ${def.label} in AI Settings first.`, {
      title: "NotepadAI",
      kind: "warning",
    });
    return;
  }
  if (!effectiveConfig.model.trim()) {
    await message(`Set a model for ${def.label} in AI Settings first.`, {
      title: "NotepadAI",
      kind: "warning",
    });
    return;
  }

  const apiKey = await getProviderApiKey(providerId);
  if (def.requiresApiKey && !apiKey) {
    await message(`${def.label} requires an API key. Add it in AI Settings first.`, {
      title: "NotepadAI",
      kind: "warning",
    });
    return;
  }

  const selectionText = selectionOverride?.text || getSelectionText();
  const input = selectionText || editor.value;
  if (!input.trim()) {
    await message("There is no text to rewrite.", {
      title: "NotepadAI",
      kind: "info",
    });
    return;
  }

  const selectedPrompt = (promptOverride || appSettings.customPrompt || DEFAULT_PROMPT).trim();
  const combinedPrompt = selectedPrompt ? `${selectedPrompt}\n\n${input}` : input;

  let spec;
  try {
    spec = def.adapter.buildChatRequest(effectiveConfig, apiKey, combinedPrompt, true);
  } catch (error) {
    await message(getErrorMessage(error), { title: "NotepadAI", kind: "error" });
    return;
  }

  const start = selectionOverride?.start ?? (editor.selectionStart || 0);
  const end = selectionOverride?.end ?? (editor.selectionEnd || 0);
  const hadSelection = Boolean(selectionText);
  const beforeText = editor.value;
  const beforeDirty = isDirty;
  const requestVersion = docVersion;

  let accumulated = "";
  let curEnd = end;
  let gotAnyDelta = false;

  setGeneratingState(true);
  const decoder = def.adapter.createStreamDecoder();

  activeStreamHandle = await startStream(spec, decoder, {
    onDelta: (text) => {
      accumulated += text;
      gotAnyDelta = true;
      if (hadSelection) {
        applyPreviewText(accumulated, { start, end: curEnd });
        curEnd = start + accumulated.length;
      } else {
        applyPreviewAll(accumulated);
      }
    },
    onDone: (aborted) => {
      setGeneratingState(false);
      activeStreamHandle = null;
      if (!gotAnyDelta) {
        suppressVersionBump = true;
        replaceAll(beforeText);
        setDirtyState(beforeDirty);
        if (!aborted) {
          void message("Empty response from the AI service.", {
            title: "NotepadAI",
            kind: "error",
          });
        }
        return;
      }
      const cleaned = cleanAiResponseText(accumulated);
      if (hadSelection) {
        applyPreviewText(cleaned, { start, end: curEnd });
      } else {
        applyPreviewAll(cleaned);
      }
      pendingAiResult = {
        text: cleaned,
        beforeText,
        beforeDirty,
        selectionStart: start,
        selectionEnd: end,
        hadSelection,
        requestVersion,
      };
      setDirtyState(true);
      showAiResultBar();
    },
    onError: (errorMessage) => {
      setGeneratingState(false);
      activeStreamHandle = null;
      if (gotAnyDelta) {
        const cleaned = cleanAiResponseText(accumulated);
        if (hadSelection) {
          applyPreviewText(cleaned, { start, end: curEnd });
        } else {
          applyPreviewAll(cleaned);
        }
        pendingAiResult = {
          text: cleaned,
          beforeText,
          beforeDirty,
          selectionStart: start,
          selectionEnd: end,
          hadSelection,
          requestVersion,
        };
        setDirtyState(true);
        showAiResultBar();
        void message(
          `Streaming was interrupted: ${errorMessage}\n\nShowing the partial result below — Apply, Keep Both, Copy, or Cancel.`,
          { title: "NotepadAI", kind: "warning" },
        );
      } else {
        suppressVersionBump = true;
        replaceAll(beforeText);
        setDirtyState(beforeDirty);
        void message(errorMessage, { title: "NotepadAI", kind: "error" });
      }
    },
  });
}

function showAbout() {
  void message("NotepadAI\nClassic notepad with an AI rewrite helper.", {
    title: "About",
    kind: "info",
  });
}

async function handleMenuEvent(id: string) {
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

  populateProviderSelect();

  try {
    await ensureAppSettingsLoaded();
  } catch (error) {
    console.error("settings load failed:", error);
  }
  renderCustomUseCaseContextButtons();

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
    aiCustomInstructionInput.value = "";
    renderCustomUseCaseContextButtons();
    openAiContextMenu(event.clientX, event.clientY);
    aiCustomInstructionInput.focus();
  });
  editor.addEventListener("scroll", closeAiContextMenu);
  editor.addEventListener("blur", (event) => {
    const next = event.relatedTarget as Node | null;
    if (next && aiContextMenu.contains(next)) return;
    closeAiContextMenu();
  });
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
    const element = event.target as HTMLElement;
    const actionTarget = element.closest("button[data-action]") as HTMLButtonElement | null;
    if (actionTarget) {
      event.preventDefault();
      const action = actionTarget.dataset.action;
      if (action) triggerQuickAction(action);
      return;
    }
    const customTarget = element.closest("button[data-custom-use-case-id]") as HTMLButtonElement | null;
    if (customTarget) {
      event.preventDefault();
      const useCaseId = customTarget.dataset.customUseCaseId;
      const useCase = appSettings.customUseCases.find((item) => item.id === useCaseId);
      if (useCase) triggerCustomInstruction(useCase.prompt);
    }
  });

  aiCustomInstructionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const instruction = aiCustomInstructionInput.value.trim();
    if (!instruction) return;
    aiCustomInstructionInput.value = "";
    triggerCustomInstruction(instruction);
  });

  aiUseCaseAdd.addEventListener("click", () => {
    void addCustomUseCase();
  });

  aiUseCaseList.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest("button[data-id]") as HTMLButtonElement | null;
    if (!target?.dataset.id) return;
    void removeCustomUseCase(target.dataset.id);
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

  aiStreamStop.addEventListener("click", () => {
    activeStreamHandle?.cancel();
  });

  aiProviderSelect.addEventListener("change", () => {
    void onProviderSelectionChanged();
  });

  aiFetchModels.addEventListener("click", () => {
    void runFetchModels();
  });

  aiTestConnection.addEventListener("click", () => {
    void runTestConnection();
  });

  aiTrustAccept.addEventListener("click", async () => {
    const action = pendingTrustAction;
    hideTrustWarning();
    if (action) await action();
  });

  aiClose.addEventListener("click", closeAiModal);
  aiCancel.addEventListener("click", closeAiModal);
  aiClear.addEventListener("click", async () => {
    await clearAiKey();
  });
  aiSave.addEventListener("click", async () => {
    await saveAiSettings();
  });

  aiModal.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target?.dataset.close === "true") closeAiModal();
  });

  await listen<string>("menu-event", (event) => {
    void handleMenuEvent(event.payload);
  });
}

void init();
