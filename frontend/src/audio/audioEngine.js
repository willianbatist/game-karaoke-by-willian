/**
 * Motor de Áudio e Relógio Mestre baseado em Web Audio API (ARCHITECTURE.md §7).
 * - Decodifica `instrumental.flac` e `vocals.flac` em AudioBuffers.
 * - Inicia ambos no mesmo timestamp exato de `AudioContext.currentTime` (deriva zero).
 * - Gerencia `offset_seek` para play, pause e seek sem perder sincronia.
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function createAudioEngine(options = {}) {
  const AudioContextImpl =
    options.AudioContextClass ??
    (typeof window !== "undefined"
      ? window.AudioContext || window.webkitAudioContext
      : null);

  const fetchImpl =
    options.fetchImpl ??
    (typeof window !== "undefined" && typeof window.fetch === "function"
      ? window.fetch.bind(window)
      : globalThis.fetch);

  const onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
  const onTimeUpdate = typeof options.onTimeUpdate === "function" ? options.onTimeUpdate : null;
  const onEnded = typeof options.onEnded === "function" ? options.onEnded : null;

  let audioCtx = null;
  let instrumentalGain = null;
  let vocalsGain = null;

  let instrumentalBuffer = null;
  let vocalsBuffer = null;

  let instrumentalSource = null;
  let vocalsSource = null;

  let state = "idle"; // idle | loading | ready | playing | paused | stopped | ended
  let duration = 0;
  let pauseOffset = 0; // posição acumulada em segundos (`offset_seek`)
  let startedAtContextTime = 0;
  let playGeneration = 0;
  let rafId = null;

  // Volumes padrão: instrumental em 100% e voz guia mutada (0%) no modo karaokê
  const volumes = {
    instrumental: clamp(Number(options.instrumentalVolume ?? 1.0), 0, 1.5),
    vocals: clamp(Number(options.vocalsVolume ?? 0.0), 0, 1.5),
  };

  function setEngineState(nextState) {
    if (state === nextState) return;
    state = nextState;
    if (onStateChange) {
      onStateChange(state);
    }
  }

  function ensureAudioContext() {
    if (!audioCtx) {
      if (!AudioContextImpl) {
        throw new Error("Web Audio API (AudioContext) não suportada neste ambiente.");
      }
      audioCtx = new AudioContextImpl();
      instrumentalGain = audioCtx.createGain();
      vocalsGain = audioCtx.createGain();

      instrumentalGain.gain.value = volumes.instrumental;
      vocalsGain.gain.value = volumes.vocals;

      instrumentalGain.connect(audioCtx.destination);
      vocalsGain.connect(audioCtx.destination);
    }
    return audioCtx;
  }

  function stopTickLoop() {
    if (rafId !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      } else {
        clearTimeout(rafId);
      }
      rafId = null;
    }
  }

  function startTickLoop() {
    stopTickLoop();
    const tick = () => {
      if (state !== "playing") return;
      const current = getCurrentTime();
      if (onTimeUpdate) {
        onTimeUpdate(current, duration);
      }
      if (duration > 0 && current >= duration) {
        handleNaturalEnd(playGeneration);
        return;
      }
      if (typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = setTimeout(tick, 16);
      }
    };

    if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = setTimeout(tick, 16);
    }
  }

  function teardownSources() {
    for (const src of [instrumentalSource, vocalsSource]) {
      if (!src) continue;
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        // Ignora caso o nó já tenha parado
      }
    }
    instrumentalSource = null;
    vocalsSource = null;
  }

  function handleNaturalEnd(generation) {
    if (generation !== playGeneration || state !== "playing") return;
    stopTickLoop();
    teardownSources();
    pauseOffset = duration;
    setEngineState("ended");
    if (onTimeUpdate) {
      onTimeUpdate(duration, duration);
    }
    if (onEnded) {
      onEnded();
    }
  }

  /**
   * Carrega e decodifica `instrumental.flac` e `vocals.flac` de uma música pronta no cache.
   */
  async function loadSong(videoId, { seekOffset = 0 } = {}) {
    playGeneration++;
    stopTickLoop();
    teardownSources();

    const ctx = ensureAudioContext();
    setEngineState("loading");

    const encodedId = encodeURIComponent(videoId);
    const instUrl = `/api/songs/${encodedId}/files/instrumental.flac`;
    const vocUrl = `/api/songs/${encodedId}/files/vocals.flac`;

    const [instRes, vocRes] = await Promise.all([fetchImpl(instUrl), fetchImpl(vocUrl)]);

    if (!instRes.ok || !vocRes.ok) {
      setEngineState("idle");
      throw new Error("Falha ao baixar os arquivos de áudio da música.");
    }

    const [instArrayBuf, vocArrayBuf] = await Promise.all([
      instRes.arrayBuffer(),
      vocRes.arrayBuffer(),
    ]);

    const [decodedInst, decodedVoc] = await Promise.all([
      ctx.decodeAudioData(instArrayBuf),
      ctx.decodeAudioData(vocArrayBuf),
    ]);

    instrumentalBuffer = decodedInst;
    vocalsBuffer = decodedVoc;
    duration = Math.max(decodedInst.duration || 0, decodedVoc.duration || 0);
    pauseOffset = clamp(Number(seekOffset) || 0, 0, duration);

    setEngineState("ready");
    if (onTimeUpdate) {
      onTimeUpdate(pauseOffset, duration);
    }

    return { duration };
  }

  /**
   * Inicia ou retoma a reprodução sincronizada dos dois stems a partir de `pauseOffset`.
   */
  async function play() {
    if (!instrumentalBuffer || !vocalsBuffer) {
      throw new Error("Nenhuma música carregada no AudioEngine.");
    }
    if (state === "playing") return;

    const ctx = ensureAudioContext();
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      await ctx.resume();
    }

    // Se já terminou, reinicia do começo
    if (state === "ended" || pauseOffset >= duration) {
      pauseOffset = 0;
    }

    teardownSources();
    const generation = ++playGeneration;

    const instSrc = ctx.createBufferSource();
    const vocSrc = ctx.createBufferSource();

    instSrc.buffer = instrumentalBuffer;
    vocSrc.buffer = vocalsBuffer;

    instSrc.connect(instrumentalGain);
    vocSrc.connect(vocalsGain);

    // Pequena margem de 15ms para agendar ambos os nós no mesmo ciclo de hardware
    const scheduleAt = ctx.currentTime + 0.015;
    startedAtContextTime = scheduleAt;

    instSrc.onended = () => handleNaturalEnd(generation);

    instSrc.start(scheduleAt, pauseOffset);
    vocSrc.start(scheduleAt, pauseOffset);

    instrumentalSource = instSrc;
    vocalsSource = vocSrc;

    setEngineState("playing");
    startTickLoop();
  }

  /**
   * Pausa a reprodução e congela o deslocamento exato (`offset_seek`).
   */
  function pause() {
    if (state !== "playing") return;
    playGeneration++;
    pauseOffset = getCurrentTime();
    stopTickLoop();
    teardownSources();
    setEngineState("paused");
    if (onTimeUpdate) {
      onTimeUpdate(pauseOffset, duration);
    }
  }

  /**
   * Salta para `targetSeconds` mantendo instrumental e voz perfeitamente alinhados.
   */
  async function seek(targetSeconds) {
    if (!instrumentalBuffer || !vocalsBuffer) return;

    const wasPlaying = state === "playing";
    playGeneration++;
    stopTickLoop();
    teardownSources();

    pauseOffset = clamp(Number(targetSeconds) || 0, 0, duration);

    if (wasPlaying) {
      state = "paused";
      await play();
    } else {
      if (state === "ended" && pauseOffset < duration) {
        setEngineState("paused");
      }
      if (onTimeUpdate) {
        onTimeUpdate(pauseOffset, duration);
      }
    }
  }

  /**
   * Para a reprodução e volta o ponteiro para 0s.
   */
  function stop() {
    playGeneration++;
    stopTickLoop();
    teardownSources();
    pauseOffset = 0;
    if (instrumentalBuffer) {
      setEngineState("stopped");
    } else {
      setEngineState("idle");
    }
    if (onTimeUpdate) {
      onTimeUpdate(0, duration);
    }
  }

  /**
   * Ajusta os ganhos de `instrumental` e `vocals` (voz guia) sem cliques de áudio.
   */
  function setStemVolumes({ instrumental, vocals } = {}) {
    if (instrumental !== undefined) {
      volumes.instrumental = clamp(Number(instrumental), 0, 1.5);
      if (instrumentalGain && audioCtx) {
        if (typeof instrumentalGain.gain.setTargetAtTime === "function") {
          instrumentalGain.gain.setTargetAtTime(volumes.instrumental, audioCtx.currentTime, 0.015);
        } else {
          instrumentalGain.gain.value = volumes.instrumental;
        }
      }
    }

    if (vocals !== undefined) {
      volumes.vocals = clamp(Number(vocals), 0, 1.5);
      if (vocalsGain && audioCtx) {
        if (typeof vocalsGain.gain.setTargetAtTime === "function") {
          vocalsGain.gain.setTargetAtTime(volumes.vocals, audioCtx.currentTime, 0.015);
        } else {
          vocalsGain.gain.value = volumes.vocals;
        }
      }
    }
  }

  function getStemVolumes() {
    return { ...volumes };
  }

  /**
   * Retorna o tempo atual da música em segundos segundo o relógio mestre AudioContext.
   */
  function getCurrentTime() {
    if (state !== "playing" || !audioCtx) {
      return pauseOffset;
    }
    const elapsed = Math.max(0, audioCtx.currentTime - startedAtContextTime);
    return clamp(pauseOffset + elapsed, 0, duration);
  }

  function getDuration() {
    return duration;
  }

  function getState() {
    return state;
  }

  function getContext() {
    return audioCtx;
  }

  async function destroy() {
    playGeneration++;
    stopTickLoop();
    teardownSources();
    if (audioCtx && typeof audioCtx.close === "function") {
      await audioCtx.close();
    }
    audioCtx = null;
    instrumentalGain = null;
    vocalsGain = null;
    instrumentalBuffer = null;
    vocalsBuffer = null;
    duration = 0;
    pauseOffset = 0;
    setEngineState("idle");
  }

  return {
    loadSong,
    play,
    pause,
    seek,
    stop,
    setStemVolumes,
    getStemVolumes,
    getCurrentTime,
    getDuration,
    getState,
    getContext,
    destroy,
  };
}