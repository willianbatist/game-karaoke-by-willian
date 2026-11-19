/**
 * Player de vídeo do YouTube em modo escravo mudo (ARCHITECTURE.md §7.2).
 * - O áudio NUNCA vem do YouTube (`mute()` forçado).
 * - O relógio mestre é o `AudioEngine`; o vídeo apenas acompanha play/pause e corrige
 *   derivas maiores que `driftThresholdSeconds` respeitando um intervalo mínimo entre seeks.
 * - Descarrega ativamente os módulos de legenda (`captions` e `cc`) para evitar sobreposição
 *   sobre a letra sincronizada do karaokê.
 * - Degrada graciosamente se o vídeo não permitir embed (erros 100/101/150) ou estiver offline.
 */

let apiLoadPromise = null;

function disableCaptions(target) {
  if (!target || typeof target.unloadModule !== "function") return;
  try {
    target.unloadModule("captions");
  } catch {
    // Ignora caso o módulo de legendas não esteja carregado
  }
  try {
    target.unloadModule("cc");
  } catch {
    // Ignora caso o módulo cc não esteja carregado
  }
}

function loadYouTubeIframeApi(timeoutMs = 8000) {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Ambiente sem window."));
  }
  if (window.YT && typeof window.YT.Player === "function") {
    return Promise.resolve(window.YT);
  }
  if (apiLoadPromise) {
    return apiLoadPromise;
  }

  apiLoadPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      apiLoadPromise = null;
      reject(new Error("Timeout ao carregar YouTube IFrame API."));
    }, timeoutMs);

    const prevCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (typeof prevCallback === "function") {
        try {
          prevCallback();
        } catch {
          // Ignora erro de callback anterior
        }
      }
      resolve(window.YT);
    };

    const existingScript = document.querySelector(
      'script[src="https://www.youtube.com/iframe_api"]'
    );
    if (!existingScript) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      tag.onerror = () => {
        clearTimeout(timer);
        apiLoadPromise = null;
        reject(new Error("Falha de rede ao carregar YouTube IFrame API."));
      };
      document.head.appendChild(tag);
    }
  });

  return apiLoadPromise;
}

export function createYouTubePlayer(options = {}) {
  const driftThresholdSeconds = Number(options.driftThresholdSeconds ?? 0.45);
  const minSeekIntervalMs = Number(options.minSeekIntervalMs ?? 1500);
  const nowFn = typeof options.nowFn === "function" ? options.nowFn : () => Date.now();
  const ytApiProvider =
    typeof options.ytApiProvider === "function" ? options.ytApiProvider : loadYouTubeIframeApi;

  const onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
  const onUnavailable = typeof options.onUnavailable === "function" ? options.onUnavailable : null;

  let player = null;
  let ready = false;
  let unavailable = false;
  let unavailableReason = null;
  let lastSeekAtMs = -Infinity;

  function markUnavailable(reason) {
    unavailable = true;
    unavailableReason = reason;
    ready = false;
    if (onUnavailable) {
      onUnavailable(reason);
    }
  }

  /**
   * Inicializa o player dentro de `containerElement` (ou ID de elemento) para `videoId`.
   */
  async function init(containerElement, videoId) {
    destroy();
    unavailable = false;
    unavailableReason = null;
    ready = false;
    lastSeekAtMs = -Infinity;

    let YT;
    try {
      YT = await ytApiProvider();
    } catch (err) {
      markUnavailable(err.message || "YouTube indisponível.");
      return { ok: false, reason: unavailableReason };
    }

    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : undefined;

    return new Promise((resolve) => {
      try {
        player = new YT.Player(containerElement, {
          videoId,
          width: "100%",
          height: "100%",
          playerVars: {
            autoplay: 0,
            cc_load_policy: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            mute: 1,
            ...(origin ? { origin } : {}),
          },
          events: {
            onReady: (evt) => {
              const target = evt?.target || player;
              try {
                target.mute?.();
                target.setVolume?.(0);
              } catch {
                // Ignora se mock não implementar setVolume
              }
              disableCaptions(target);
              ready = true;
              resolve({ ok: true });
            },
            onApiChange: (evt) => {
              // Disparado quando módulos internos (como legendas automáticas) são carregados
              disableCaptions(evt?.target || player);
            },
            onStateChange: (evt) => {
              const target = evt?.target || player;
              // Garante que o player permaneça sempre mudo e sem legendas após mudança de estado
              try {
                if (target && typeof target.isMuted === "function" && !target.isMuted()) {
                  target.mute();
                }
              } catch {
                // Ignora
              }
              disableCaptions(target);
              if (onStateChange) {
                onStateChange(evt?.data);
              }
            },
            onError: (evt) => {
              const code = evt?.data;
              markUnavailable(`Erro do player do YouTube (código ${code ?? "desconhecido"}).`);
              resolve({ ok: false, reason: unavailableReason });
            },
          },
        });
      } catch (err) {
        markUnavailable(err.message || "Falha ao instanciar player do YouTube.");
        resolve({ ok: false, reason: unavailableReason });
      }
    });
  }

  /**
   * Sincroniza o estado (`isPlaying`) e o relógio (`masterTimeSeconds`) com o AudioEngine.
   */
  function syncToMaster(masterTimeSeconds, isPlaying) {
    if (!ready || unavailable || !player) return;

    try {
      if (typeof player.isMuted === "function" && !player.isMuted()) {
        player.mute();
      }

      const ytState = typeof player.getPlayerState === "function" ? player.getPlayerState() : null;
      // Estados oficiais da YouTube API: 1 = PLAYING, 2 = PAUSED, 3 = BUFFERING
      if (isPlaying) {
        if (ytState !== 1 && ytState !== 3) {
          player.playVideo?.();
          disableCaptions(player);
        }
      } else if (ytState === 1) {
        player.pauseVideo?.();
      }

      const ytTime = typeof player.getCurrentTime === "function" ? Number(player.getCurrentTime()) : 0;
      const drift = Math.abs(ytTime - masterTimeSeconds);
      const now = nowFn();

      if (drift > driftThresholdSeconds && now - lastSeekAtMs >= minSeekIntervalMs) {
        lastSeekAtMs = now;
        player.seekTo?.(Math.max(0, masterTimeSeconds), true);
      }
    } catch {
      // Falhas transitórias de postMessage não devem derrubar o loop de renderização
    }
  }

  /**
   * Força salto imediato (usado quando o usuário arrasta a barra de progresso manualmente).
   */
  function forceSeek(targetSeconds) {
    if (!ready || unavailable || !player) return;
    try {
      lastSeekAtMs = nowFn();
      player.seekTo?.(Math.max(0, targetSeconds), true);
    } catch {
      // Ignora
    }
  }

  function isAvailable() {
    return ready && !unavailable;
  }

  function getStatus() {
    return {
      ready,
      unavailable,
      reason: unavailableReason,
    };
  }

  function destroy() {
    if (player && typeof player.destroy === "function") {
      try {
        player.destroy();
      } catch {
        // Ignora
      }
    }
    player = null;
    ready = false;
  }

  return {
    init,
    syncToMaster,
    forceSeek,
    isAvailable,
    getStatus,
    destroy,
  };
}