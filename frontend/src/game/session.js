/**
 * Modelo de sessão/partida (FRONTEND_ARCHITECTURE.md §3.3, §8.2 e T4.4).
 * Isola o ciclo da partida (setup -> start -> frame -> end) atrás da abstração de modos.
 */

import { historyClient } from "../history/historyClient.js";
import { getState, setState } from "../store.js";
import { getDefaultMode, getMode } from "./modes/registry.js";

export const PREFS_STORAGE_KEY = "karaoke.prefs.v1";

export const DEFAULT_GAME_PREFS = Object.freeze({
  difficulty: "normal",
  showVideo: true,
  countdownSeconds: 3,
  showPartialScore: false,
  autoTranspose: true,
  recordAbandoned: false,
  recordGuest: true,
});

export function loadGamePrefs() {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return { ...DEFAULT_GAME_PREFS };
    }
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GAME_PREFS };
    const parsed = JSON.parse(raw);
    const difficulty = ["easy", "normal", "hard"].includes(parsed.difficulty)
      ? parsed.difficulty
      : "normal";

    return {
      difficulty,
      showVideo: parsed.showVideo !== false,
      countdownSeconds: Math.max(0, Math.min(5, Number(parsed.countdownSeconds ?? 3))),
      showPartialScore: Boolean(parsed.showPartialScore ?? false),
      autoTranspose:
        parsed.autoTranspose === undefined || parsed.autoTranspose === null
          ? difficulty !== "hard"
          : Boolean(parsed.autoTranspose),
      recordAbandoned: Boolean(parsed.recordAbandoned ?? false),
      recordGuest: parsed.recordGuest !== false,
    };
  } catch {
    return { ...DEFAULT_GAME_PREFS };
  }
}

export function createGameSession({
  modeId = "standard",
  player = null,
  song = {},
  difficulty = null,
  assists = {},
  prefs = null,
  client = historyClient,
} = {}) {
  const chosenMode = getMode(modeId);
  const mode = chosenMode && chosenMode.enabled ? chosenMode : getDefaultMode();
  const effectivePrefs = prefs ? { ...DEFAULT_GAME_PREFS, ...prefs } : loadGamePrefs();
  const activePlayer = player || getState().player || { id: null, name: "Convidado", isGuest: true };

  const sessionState = mode.setup({
    player: activePlayer,
    song,
    difficulty: difficulty || effectivePrefs.difficulty,
    assists,
    prefs: effectivePrefs,
  });

  setState({
    mode: mode.id,
    session: sessionState,
  });

  function start() {
    mode.onStart(sessionState);
    setState({ session: { ...sessionState } });
    return sessionState;
  }

  function pushFrame(frameEval) {
    return mode.onFrame(sessionState, frameEval);
  }

  async function finish(rawResult = {}) {
    const outcome = await mode.onEnd(
      sessionState,
      { ...rawResult, completed: true },
      { client }
    );
    const summaryView = mode.summary(outcome);
    setState({
      session: { ...sessionState },
      lastResultEntry: outcome.entry,
      lastResultPersistence: outcome.persistence,
    });
    return {
      ...outcome,
      summary: summaryView,
    };
  }

  async function abort(rawResult = {}) {
    const outcome = await mode.onEnd(
      sessionState,
      { ...rawResult, completed: false },
      { client }
    );
    setState({
      session: null,
    });
    return outcome;
  }

  return {
    mode,
    getState: () => sessionState,
    start,
    pushFrame,
    finish,
    abort,
  };
}