/**
 * Store global reativo (pub/sub) para estado e preferências da aplicação frontend.
 */

const THEME_STORAGE_KEY = "karaoke.theme";
const AUDIO_SETTINGS_KEY = "karaoke.audioSettings";
const VALID_THEMES = new Set(["dark", "light"]);

export const DEFAULT_AUDIO_SETTINGS = Object.freeze({
  micDeviceId: "",
  inputGain: 1.0,
  rmsThreshold: 0.01,
  micLatencyMs: 0,
  defaultInstrumentalVol: 1.0,
  defaultVocalsVol: 0.0,
});

function getStorage() {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignora bloqueio de storage
  }
  return null;
}

function readStorageItem(key) {
  const storage = getStorage();
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageItem(key, value) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Ignora falha de quota
  }
}

function loadStoredAudioSettings() {
  try {
    const raw = readStorageItem(AUDIO_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_AUDIO_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      micDeviceId: typeof parsed.micDeviceId === "string" ? parsed.micDeviceId : "",
      inputGain: Math.max(0.2, Math.min(4.0, Number(parsed.inputGain ?? 1.0) || 1.0)),
      rmsThreshold: Math.max(0.001, Math.min(0.2, Number(parsed.rmsThreshold ?? 0.01) || 0.01)),
      micLatencyMs: Math.max(-300, Math.min(500, Math.round(Number(parsed.micLatencyMs ?? 0) || 0))),
      defaultInstrumentalVol: Math.max(0, Math.min(1, Number(parsed.defaultInstrumentalVol ?? 1.0))),
      defaultVocalsVol: Math.max(0, Math.min(1, Number(parsed.defaultVocalsVol ?? 0.0))),
    };
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

const savedTheme = readStorageItem(THEME_STORAGE_KEY);
const initialTheme = VALID_THEMES.has(savedTheme) ? savedTheme : "dark";
if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.dataset.theme = initialTheme;
}

const state = {
  theme: initialTheme,
  locale: "pt-BR",
  config: null,
  health: null,
  songs: [],
  songsCount: 0,
  banner: null,
  route: { name: "home", params: {} },
  audioSettings: loadStoredAudioSettings(),
};

const listeners = new Set();

function notify() {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      console.error("[store] Erro em listener:", err);
    }
  }
}

export function getState() {
  return state;
}

export function setState(partial) {
  Object.assign(state, partial);
  notify();
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setTheme(theme) {
  const next = VALID_THEMES.has(theme) ? theme : "dark";
  writeStorageItem(THEME_STORAGE_KEY, next);
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.theme = next;
  }
  setState({ theme: next });
}

export function getAudioSettings() {
  return { ...state.audioSettings };
}

export function updateAudioSettings(partial) {
  const merged = {
    ...state.audioSettings,
    ...partial,
  };
  merged.inputGain = Math.max(0.2, Math.min(4.0, Number(merged.inputGain) || 1.0));
  merged.rmsThreshold = Math.max(0.001, Math.min(0.2, Number(merged.rmsThreshold) || 0.01));
  merged.micLatencyMs = Math.max(-300, Math.min(500, Math.round(Number(merged.micLatencyMs) || 0)));
  merged.defaultInstrumentalVol = Math.max(0, Math.min(1, Number(merged.defaultInstrumentalVol)));
  merged.defaultVocalsVol = Math.max(0, Math.min(1, Number(merged.defaultVocalsVol)));

  writeStorageItem(AUDIO_SETTINGS_KEY, JSON.stringify(merged));
  setState({ audioSettings: merged });
  return merged;
}

export function resetAudioSettings() {
  const fresh = { ...DEFAULT_AUDIO_SETTINGS };
  writeStorageItem(AUDIO_SETTINGS_KEY, JSON.stringify(fresh));
  setState({ audioSettings: fresh });
  return fresh;
}

export function showBanner(type, message) {
  setState({ banner: { type, message } });
}

export function clearBanner() {
  setState({ banner: null });
}