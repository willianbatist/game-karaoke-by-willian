/**
 * Cliente HTTP e SSE para comunicação com o backend local (CONTRACTS.md §5).
 */

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

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

  getSongs() {
    return requestJson("/api/songs");
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

  prepareSong(videoId) {
    return requestJson("/api/prepare", {
      method: "POST",
      body: JSON.stringify({ videoId }),
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