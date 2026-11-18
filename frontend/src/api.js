/**
 * Cliente HTTP e SSE para comunicação com o backend local (CONTRACTS.md §5).
 */

async function requestJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
  } catch (networkErr) {
    const err = new Error("Servidor local indisponível.");
    err.code = "NETWORK_ERROR";
    err.isNetworkError = true;
    err.cause = networkErr;
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const err = new Error(data?.error?.message || `Erro HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code || "HTTP_ERROR";
    throw err;
  }

  return data;
}

export const api = {
  getConfig() {
    return requestJson("/api/config");
  },

  getHealth(refresh = false) {
    const query = refresh ? "?refresh=1" : "";
    return requestJson(`/api/health${query}`);
  },

  searchSongs(query) {
    return requestJson(`/api/search?q=${encodeURIComponent(String(query || ""))}`);
  },

  getSongs({ q = "", sort = "" } = {}) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (sort) params.set("sort", sort);
    const qs = params.toString();
    return requestJson(`/api/songs${qs ? `?${qs}` : ""}`);
  },

  getSong(videoId, { preview = false } = {}) {
    const query = preview ? "?preview=1" : "";
    return requestJson(`/api/songs/${encodeURIComponent(videoId)}${query}`);
  },

  patchSong(videoId, patch) {
    return requestJson(`/api/songs/${encodeURIComponent(videoId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  deleteSong(videoId) {
    return requestJson(`/api/songs/${encodeURIComponent(videoId)}`, {
      method: "DELETE",
    });
  },

  prepareSong(videoId, metadata = {}) {
    const payload = { videoId };
    if (typeof metadata.title === "string" && metadata.title.trim()) {
      payload.title = metadata.title.trim();
    }
    if (typeof metadata.channel === "string" && metadata.channel.trim()) {
      payload.channel = metadata.channel.trim();
    }
    if (Number.isFinite(Number(metadata.duration)) && Number(metadata.duration) > 0) {
      payload.duration = Number(metadata.duration);
    }
    return requestJson("/api/prepare", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  getJob(jobId) {
    return requestJson(`/api/jobs/${encodeURIComponent(jobId)}`);
  },

  cancelJob(jobId) {
    return requestJson(`/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    });
  },

  // Jogadores (CONTRACTS.md §5.2)
  getPlayers() {
    return requestJson("/api/players");
  },

  createPlayer(name) {
    return requestJson("/api/players", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },

  renamePlayer(playerId, name) {
    return requestJson(`/api/players/${encodeURIComponent(playerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  },

  deletePlayer(playerId, history = "keep") {
    return requestJson(
      `/api/players/${encodeURIComponent(playerId)}?history=${encodeURIComponent(history)}`,
      { method: "DELETE" }
    );
  },

  // Histórico, Rankings e Exportação (CONTRACTS.md §5.2)
  getHistory({ playerId = "", videoId = "", difficulty = "", from = "", to = "", limit = "" } = {}) {
    const params = new URLSearchParams();
    if (playerId) params.set("player_id", playerId);
    if (videoId) params.set("video_id", videoId);
    if (difficulty) params.set("difficulty", difficulty);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (limit !== "" && limit !== null && limit !== undefined) {
      params.set("limit", String(limit));
    }
    const qs = params.toString();
    return requestJson(`/api/history${qs ? `?${qs}` : ""}`);
  },

  getHistoryEntry(entryId) {
    return requestJson(`/api/history/${encodeURIComponent(entryId)}`);
  },

  postHistory(entry) {
    return requestJson("/api/history", {
      method: "POST",
      body: JSON.stringify(entry),
    });
  },

  deleteHistoryEntry(entryId) {
    return requestJson(`/api/history/${encodeURIComponent(entryId)}`, {
      method: "DELETE",
    });
  },

  clearHistory({ playerId = "", confirm = "" } = {}) {
    const params = new URLSearchParams();
    if (playerId) params.set("player_id", playerId);
    if (confirm) params.set("confirm", confirm);
    const qs = params.toString();
    return requestJson(`/api/history${qs ? `?${qs}` : ""}`, {
      method: "DELETE",
    });
  },

  getRankings(videoId) {
    return requestJson(`/api/history/rankings?video_id=${encodeURIComponent(videoId)}`);
  },

  getHistoryExportUrl({
    format = "csv",
    playerId = "",
    bom = "1",
    sep = ";",
    decimal = "comma",
  } = {}) {
    const params = new URLSearchParams();
    params.set("format", format);
    if (playerId) params.set("player_id", playerId);
    if (format === "csv") {
      params.set("bom", bom ? "1" : "0");
      params.set("sep", sep);
      params.set("decimal", decimal);
    }
    return `/api/history/export?${params.toString()}`;
  },

  /**
   * Inscreve-se no fluxo SSE de um job (`GET /api/jobs/:id/events`).
   * Retorna uma função `close()` para encerrar a conexão.
   */
  subscribeJobEvents(jobId, { onEvent, onError } = {}) {
    const url = `/api/jobs/${encodeURIComponent(jobId)}/events`;
    const source = new EventSource(url);

    source.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data);
        if (typeof onEvent === "function") {
          onEvent(parsed);
        }
        if (
          parsed.event === "state" &&
          (parsed.state === "ready" || parsed.state === "failed" || parsed.state === "canceled")
        ) {
          source.close();
        }
      } catch {
        // Ignora pacotes malformados
      }
    };

    source.onerror = (err) => {
      if (typeof onError === "function") {
        onError(err);
      }
      source.close();
    };

    return () => source.close();
  },
};