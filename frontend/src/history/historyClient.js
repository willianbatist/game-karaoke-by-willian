/**
 * Cliente de histórico com fila offline resiliente (FRONTEND_ARCHITECTURE.md §8.3, §10 e CONTRACTS.md §10).
 * Grava partidas em `POST /api/history` e, se o backend estiver inacessível,
 * enfileira em `karaoke.pendingHistory.v1` (com espelho em memória) para reenvio automático.
 */

import { api } from "../api.js";
import { setState } from "../store.js";

export const PENDING_HISTORY_STORAGE_KEY = "karaoke.pendingHistory.v1";

function getBrowserStorage() {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignora bloqueio de storage
  }
  return null;
}

function isRetryableBackendError(err) {
  if (!err) return false;
  if (err.isNetworkError === true) return true;
  if (err.code === "NETWORK_ERROR") return true;
  if (typeof err.status === "number" && (err.status === 503 || err.status >= 500)) {
    return true;
  }
  return false;
}

export function createHistoryClient({
  apiClient = api,
  storage = getBrowserStorage(),
  retryIntervalMs = 10000,
  autoStart = true,
} = {}) {
  let flushing = false;
  let retryTimerId = null;
  let memoryQueue = [];
  const listeners = new Set();

  if (storage) {
    try {
      const initialRaw = storage.getItem(PENDING_HISTORY_STORAGE_KEY);
      if (initialRaw) {
        const parsed = JSON.parse(initialRaw);
        if (Array.isArray(parsed)) {
          memoryQueue = parsed;
        }
      }
    } catch {
      memoryQueue = [];
    }
  }

  function readQueue() {
    if (storage) {
      try {
        const raw = storage.getItem(PENDING_HISTORY_STORAGE_KEY);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            memoryQueue = parsed;
          }
        }
      } catch {
        // Mantém fallback em memória
      }
    }
    return [...memoryQueue];
  }

  function writeQueue(items) {
    memoryQueue = Array.isArray(items) ? [...items] : [];
    if (!storage) return;
    try {
      if (memoryQueue.length === 0) {
        storage.removeItem(PENDING_HISTORY_STORAGE_KEY);
      } else {
        storage.setItem(PENDING_HISTORY_STORAGE_KEY, JSON.stringify(memoryQueue));
      }
    } catch {
      // Mantém fallback em memória se quota do navegador estourar
    }
  }

  function notifyQueueState() {
    const count = readQueue().length;
    setState({ pendingHistoryCount: count });
    for (const fn of listeners) {
      try {
        fn(count);
      } catch {
        // Ignora erro em listener
      }
    }
    if (count > 0) {
      ensureRetryTimer();
    } else {
      stopRetryTimer();
    }
  }

  function enqueuePending(entry) {
    const current = readQueue();
    const withoutDup = current.filter((item) => item?.id !== entry.id);
    withoutDup.push(entry);
    writeQueue(withoutDup);
    notifyQueueState();
  }

  function removePendingById(entryId) {
    const current = readQueue();
    const filtered = current.filter((item) => item?.id !== entryId);
    if (filtered.length !== current.length) {
      writeQueue(filtered);
      notifyQueueState();
    }
  }

  function stopRetryTimer() {
    if (retryTimerId !== null) {
      clearInterval(retryTimerId);
      retryTimerId = null;
    }
  }

  function ensureRetryTimer() {
    if (!autoStart || retryTimerId !== null || retryIntervalMs <= 0) return;
    retryTimerId = setInterval(() => {
      if (readQueue().length > 0) {
        flushPending();
      } else {
        stopRetryTimer();
      }
    }, retryIntervalMs);
  }

  /**
   * Tenta reenviar todas as partidas acumuladas em `karaoke.pendingHistory.v1`.
   */
  async function flushPending() {
    if (flushing) {
      return { flushed: 0, remaining: readQueue().length };
    }

    const queue = readQueue();
    if (queue.length === 0) {
      notifyQueueState();
      return { flushed: 0, remaining: 0 };
    }

    flushing = true;
    let flushedCount = 0;

    try {
      for (const item of queue) {
        try {
          await apiClient.postHistory(item);
          removePendingById(item.id);
          flushedCount += 1;
        } catch (err) {
          if (isRetryableBackendError(err)) {
            break;
          }
          removePendingById(item.id);
        }
      }
    } finally {
      flushing = false;
      notifyQueueState();
    }

    return {
      flushed: flushedCount,
      remaining: readQueue().length,
    };
  }

  /**
   * Grava uma partida concluída no backend; em caso de queda do servidor local,
   * guarda na fila offline sem lançar exceção.
   */
  async function recordMatch(entry) {
    try {
      const saved = await apiClient.postHistory(entry);
      removePendingById(entry.id);
      if (readQueue().length > 0) {
        flushPending();
      }
      return {
        synced: true,
        pending: false,
        entry: saved,
      };
    } catch (err) {
      if (isRetryableBackendError(err)) {
        enqueuePending(entry);
        return {
          synced: false,
          pending: true,
          entry,
        };
      }
      throw err;
    }
  }

  function getPendingEntries() {
    return readQueue();
  }

  function getPendingCount() {
    return readQueue().length;
  }

  function subscribePending(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function handleOnline() {
    flushPending();
  }

  if (autoStart && typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("online", handleOnline);
  }

  notifyQueueState();
  if (autoStart && readQueue().length > 0) {
    flushPending();
  }

  return {
    recordMatch,
    flushPending,
    getPendingEntries,
    getPendingCount,
    subscribePending,
    listHistory: (filters) => apiClient.getHistory(filters),
    getEntry: (id) => apiClient.getHistoryEntry(id),
    deleteEntry: (id) => apiClient.deleteHistoryEntry(id),
    clearHistory: (opts) => apiClient.clearHistory(opts),
    getRankings: (videoId) => apiClient.getRankings(videoId),
    getExportUrl: (opts) => apiClient.getHistoryExportUrl(opts),
    destroy() {
      stopRetryTimer();
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("online", handleOnline);
      }
    },
  };
}

export const historyClient = createHistoryClient();