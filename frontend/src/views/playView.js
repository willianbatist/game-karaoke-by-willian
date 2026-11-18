/**
 * Tela de Jogo Completa (#/play/:videoId) — T3.3 + T4.4 + Melhorias de Experiência:
 * - AudioEngine (relógio mestre) + LyricSync + YouTubePlayer escravo mudo
 * - Pista de Afinação (pitchLane.js) com dobramento de oitava e cursor magnético
 * - Motor de Pontuação Híbrido (Afinação + Sincronia de Letra)
 * - Medidor de microfone (micMeter.js) + detecção de vazamento e desconexão
 * - Contagem regressiva 3-2-1, Menu de Pausa, atalhos (Espaço, Esc, F, Setas) e Wake Lock
 */

import { api } from "../api.js";
import { createAudioEngine } from "../audio/audioEngine.js";
import { createMicCapture } from "../audio/micCapture.js";
import { midiToNoteName } from "../audio/yinDetector.js";
import { createScoringEngine } from "../game/scoringEngine.js";
import { createGameSession, loadGamePrefs } from "../game/session.js";
import { t } from "../i18n.js";
import { createLyricSync } from "../player/lyricSync.js";
import { createYouTubePlayer } from "../player/youtubePlayer.js";
import { navigate } from "../router.js";
import { getAudioSettings, getState, showBanner } from "../store.js";
import { createMicMeter } from "../ui/components/micMeter.js";
import { createPitchLane } from "../ui/components/pitchLane.js";
import { confirmDialog } from "../ui/confirmModal.js";

function formatClock(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function fetchPitchMap(videoId) {
  const res = await fetch(`/api/songs/${encodeURIComponent(videoId)}/files/pitch_map.json`);
  if (!res.ok) return null;
  return res.json();
}

export function renderPlayView(container, params) {
  const { videoId } = params;
  const audioSettings = getAudioSettings();
  const prefs = loadGamePrefs();
  const appConfig = getState().config || {};
  const cfgAudio = appConfig.audio || {};
  const cfgTolerances = appConfig.tolerances || null;
  const cfgScoring = appConfig.scoring || {};
  const cfgHeuristic = cfgScoring.heuristic || null;
  const cfgScoringWeights = cfgScoring.weights || null;
  const cfgAutoTransposeMap = cfgScoring.auto_transpose_by_difficulty || null;
  const cfgVisualSnap = cfgScoring.visual_snap || null;
  const lyricWindowPadding = Number(cfgScoring.lyric_window_padding_seconds ?? 0.5);
  const pitchConfThreshold = Number(cfgAudio.pitch_conf_threshold ?? 0.6);

  let disposed = false;
  let songFinished = false;
  let isSeekingSlider = false;
  let lastRenderedLineIndex = -999;

  let manifestData = null;
  let pitchMapData = null;
  let scoringEngine = null;
  let gameSession = null;
  let songDurationSec = 0;
  let currentLatencyMs = Number(audioSettings.micLatencyMs) || 0;
  let currentDifficulty = prefs.difficulty;
  let videoEnabled = prefs.showVideo;

  // Controle de contagem regressiva e pausa
  let countdownTimerId = null;
  let pauseMenuOpen = false;
  let wakeLockSentinel = null;

  // Heurística leve de vazamento de caixas
  let unvoicedBleedAccumSec = 0;
  let bleedWarningDismissed = false;

  const initInstVol = audioSettings.defaultInstrumentalVol;
  const initVocVol = audioSettings.defaultVocalsVol;

  container.innerHTML = `
    <div id="play-shell" class="play-shell">
      <div class="play-topbar">
        <div class="play-topbar-left">
          <button type="button" id="play-exit-btn" class="btn btn-secondary">
            ← ${t("play.backBtn")}
          </button>
          <div class="play-song-info">
            <h2 id="play-title" class="play-song-title"></h2>
            <span id="play-channel" class="muted" style="font-size: 0.85rem;"></span>
          </div>
        </div>

        <div class="play-topbar-actions">
          <div class="play-lyrics-tools" id="play-lyrics-tools" hidden>
            <select id="play-lyrics-select" class="select-control" aria-label="${t("play.lyricsSelectLabel")}"></select>
            <button type="button" id="play-offset-minus" class="btn btn-secondary" title="Atrasar letra (-100ms)">-100ms</button>
            <span id="play-offset-label" class="mono" style="font-size: 0.85rem;">0 ms</span>
            <button type="button" id="play-offset-plus" class="btn btn-secondary" title="Adiantar letra (+100ms)">+100ms</button>
          </div>
          <button type="button" id="play-fullscreen-btn" class="btn btn-secondary" title="Tela cheia (F)">
            Tela cheia
          </button>
          <button type="button" id="play-pause-menu-btn" class="btn btn-secondary" title="Menu de pausa (Esc)">
            Menu (Esc)
          </button>
        </div>
      </div>

      <div id="stage-alert-bar" class="stage-alert-bar" role="status" aria-live="polite" hidden>
        <span id="stage-alert-text"></span>
        <button type="button" id="stage-alert-close" class="btn btn-secondary">OK</button>
      </div>

      <div class="vocal-hud-bar">
        <div class="vocal-hud-left">
          <button type="button" id="play-mic-btn" class="btn btn-secondary">
            ${t("play.micOffBtn")}
          </button>
          <div id="mic-meter-host" class="mic-meter-host"></div>
          <span id="play-latency-chip" class="mono muted" style="font-size: 0.8rem;"></span>
        </div>

        <div class="vocal-hud-right">
          <span id="play-score-pill" class="score-hud-pill" ${prefs.showPartialScore ? "" : "hidden"}>
            Nota <strong id="play-live-score">0.0</strong>
          </span>
          <span class="score-hud-pill">
            Seq. <strong id="play-live-streak">0</strong>
          </span>
          <span id="play-sung-note" class="stage-note-pill">--</span>
          <span id="play-hit-badge" class="hit-badge">${t("play.hitIdle")}</span>
        </div>
      </div>

      <section class="stage-arena">
        <div id="stage-video-wrapper" class="stage-video-wrapper" ${videoEnabled ? "" : "hidden"}>
          <div id="yt-player-target"></div>
        </div>
        <div id="yt-fallback-badge" class="stage-video-fallback" hidden>
          ${t("play.videoUnavailable")}
        </div>

        <div id="pitch-lane-wrapper" class="pitch-lane-wrapper"></div>

        <div id="lyrics-overlay" class="lyrics-overlay">
          <div class="lyric-current">${t("play.loadingAudio")}</div>
        </div>

        <!-- Overlay de Contagem Regressiva (3 - 2 - 1) -->
        <div id="countdown-overlay" class="stage-modal-overlay" hidden>
          <div class="muted" style="font-weight: 600;">Prepare-se para cantar</div>
          <div id="countdown-number" class="countdown-number">3</div>
          <button type="button" id="countdown-skip-btn" class="btn btn-secondary">
            Começar agora
          </button>
        </div>

        <!-- Overlay do Menu de Pausa (Esc) -->
        <div id="pause-overlay" class="stage-modal-overlay" role="dialog" aria-modal="true" aria-label="Menu de pausa" hidden>
          <div class="pause-card">
            <h3>Partida Pausada</h3>

            <div class="pause-row">
              <span>Ajustar letra (setas ← / →)</span>
              <div class="pause-row-controls">
                <button type="button" id="pause-offset-minus" class="btn btn-secondary">-100ms</button>
                <span id="pause-offset-val" class="mono">0 ms</span>
                <button type="button" id="pause-offset-plus" class="btn btn-secondary">+100ms</button>
              </div>
            </div>

            <div class="pause-row">
              <span>Ajustar latência do microfone</span>
              <div class="pause-row-controls">
                <button type="button" id="pause-lat-minus" class="btn btn-secondary">-10ms</button>
                <span id="pause-lat-val" class="mono">0 ms</span>
                <button type="button" id="pause-lat-plus" class="btn btn-secondary">+10ms</button>
              </div>
            </div>

            <div class="pause-row">
              <span>Volume da voz guia</span>
              <div class="pause-row-controls">
                <input type="range" id="pause-vocals-slider" min="0" max="1" step="0.05" value="${initVocVol}" />
                <span id="pause-vocals-val" class="mono">${Math.round(initVocVol * 100)}%</span>
              </div>
            </div>

            <div class="pause-row">
              <span>Vídeo de fundo</span>
              <button type="button" id="pause-video-toggle" class="btn btn-secondary">
                ${videoEnabled ? "Ocultar vídeo" : "Mostrar vídeo"}
              </button>
            </div>

            <div class="pause-actions">
              <button type="button" id="pause-resume-btn" class="btn btn-primary">Continuar</button>
              <button type="button" id="pause-restart-btn" class="btn btn-secondary">Reiniciar</button>
              <button type="button" id="pause-settings-btn" class="btn btn-secondary">Configurações de Áudio</button>
              <button type="button" id="pause-exit-btn" class="btn btn-secondary">Sair</button>
            </div>
          </div>
        </div>
      </section>

      <section class="play-controls-card">
        <div class="timeline-row">
          <span id="play-time-current" class="mono">00:00</span>
          <input
            type="range"
            id="play-timeline"
            class="timeline-slider"
            min="0"
            max="100"
            step="0.1"
            value="0"
            disabled
          />
          <span id="play-time-total" class="mono">00:00</span>
        </div>

        <div class="transport-and-mixer">
          <div class="transport-buttons">
            <button type="button" id="play-toggle-btn" class="btn btn-primary" disabled>
              ${t("play.playBtn")}
            </button>
            <button type="button" id="play-restart-btn" class="btn btn-secondary" disabled>
              ${t("play.restartBtn")}
            </button>
          </div>

          <div class="mixer-sliders">
            <label class="mixer-channel">
              <span>${t("play.instrumentalVol")}</span>
              <input type="range" id="vol-instrumental" min="0" max="1" step="0.05" value="${initInstVol}" />
              <span id="vol-instrumental-val" class="mono">${Math.round(initInstVol * 100)}%</span>
            </label>

            <label class="mixer-channel">
              <span>${t("play.vocalsVol")}</span>
              <input type="range" id="vol-vocals" min="0" max="1" step="0.05" value="${initVocVol}" />
              <span id="vol-vocals-val" class="mono">${Math.round(initVocVol * 100)}%</span>
            </label>
          </div>
        </div>
      </section>
    </div>
  `;

  // Referências DOM
  const playShellEl = container.querySelector("#play-shell");
  const exitBtn = container.querySelector("#play-exit-btn");
  const titleEl = container.querySelector("#play-title");
  const channelEl = container.querySelector("#play-channel");
  const lyricsToolsEl = container.querySelector("#play-lyrics-tools");
  const lyricsSelectEl = container.querySelector("#play-lyrics-select");
  const offsetMinusBtn = container.querySelector("#play-offset-minus");
  const offsetPlusBtn = container.querySelector("#play-offset-plus");
  const offsetLabelEl = container.querySelector("#play-offset-label");
  const fullscreenBtn = container.querySelector("#play-fullscreen-btn");
  const pauseMenuBtn = container.querySelector("#play-pause-menu-btn");

  const stageAlertBar = container.querySelector("#stage-alert-bar");
  const stageAlertText = container.querySelector("#stage-alert-text");
  const stageAlertClose = container.querySelector("#stage-alert-close");

  const micBtn = container.querySelector("#play-mic-btn");
  const micMeterHost = container.querySelector("#mic-meter-host");
  const latencyChipEl = container.querySelector("#play-latency-chip");
  const liveScoreEl = container.querySelector("#play-live-score");
  const liveStreakEl = container.querySelector("#play-live-streak");
  const sungNoteEl = container.querySelector("#play-sung-note");
  const hitBadgeEl = container.querySelector("#play-hit-badge");

  const videoWrapperEl = container.querySelector("#stage-video-wrapper");
  const ytTargetEl = container.querySelector("#yt-player-target");
  const ytFallbackBadge = container.querySelector("#yt-fallback-badge");
  const pitchLaneWrapper = container.querySelector("#pitch-lane-wrapper");
  const lyricsOverlayEl = container.querySelector("#lyrics-overlay");

  const countdownOverlay = container.querySelector("#countdown-overlay");
  const countdownNumberEl = container.querySelector("#countdown-number");
  const countdownSkipBtn = container.querySelector("#countdown-skip-btn");

  const pauseOverlay = container.querySelector("#pause-overlay");
  const pauseOffsetMinus = container.querySelector("#pause-offset-minus");
  const pauseOffsetVal = container.querySelector("#pause-offset-val");
  const pauseOffsetPlus = container.querySelector("#pause-offset-plus");
  const pauseLatMinus = container.querySelector("#pause-lat-minus");
  const pauseLatVal = container.querySelector("#pause-lat-val");
  const pauseLatPlus = container.querySelector("#pause-lat-plus");
  const pauseVocalsSlider = container.querySelector("#pause-vocals-slider");
  const pauseVocalsVal = container.querySelector("#pause-vocals-val");
  const pauseVideoToggle = container.querySelector("#pause-video-toggle");
  const pauseResumeBtn = container.querySelector("#pause-resume-btn");
  const pauseRestartBtn = container.querySelector("#pause-restart-btn");
  const pauseSettingsBtn = container.querySelector("#pause-settings-btn");
  const pauseExitBtn = container.querySelector("#pause-exit-btn");

  const timeCurrentEl = container.querySelector("#play-time-current");
  const timeTotalEl = container.querySelector("#play-time-total");
  const timelineSlider = container.querySelector("#play-timeline");
  const toggleBtn = container.querySelector("#play-toggle-btn");
  const restartBtn = container.querySelector("#play-restart-btn");

  const instSlider = container.querySelector("#vol-instrumental");
  const instValEl = container.querySelector("#vol-instrumental-val");
  const vocSlider = container.querySelector("#vol-vocals");
  const vocValEl = container.querySelector("#vol-vocals-val");

  titleEl.textContent = videoId;
  channelEl.textContent = t("play.loadingAudio");
  latencyChipEl.textContent = `${currentLatencyMs} ms`;
  pauseLatVal.textContent = `${currentLatencyMs} ms`;

  function showStageAlert(message) {
    if (!stageAlertBar || !stageAlertText) return;
    stageAlertText.textContent = String(message);
    stageAlertBar.hidden = false;
  }

  stageAlertClose?.addEventListener("click", () => {
    stageAlertBar.hidden = true;
    bleedWarningDismissed = true;
  });

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator && !wakeLockSentinel) {
        wakeLockSentinel = await navigator.wakeLock.request("screen");
        wakeLockSentinel.addEventListener("release", () => {
          wakeLockSentinel = null;
        });
      }
    } catch {
      // Ignora silenciosamente se o navegador/SO negar Wake Lock
    }
  }

  async function releaseWakeLock() {
    try {
      if (wakeLockSentinel) {
        await wakeLockSentinel.release();
        wakeLockSentinel = null;
      }
    } catch {
      wakeLockSentinel = null;
    }
  }

  const micMeter = createMicMeter(micMeterHost, {
    clarityThreshold: Number(cfgAudio.clarity_off ?? 0.7),
  });

  const lyricSync = createLyricSync();

  const youtubePlayer = createYouTubePlayer({
    driftThresholdSeconds: Number(cfgAudio.youtube_drift_threshold_seconds ?? 0.35),
    onUnavailable: () => {
      if (!disposed) {
        if (videoWrapperEl) videoWrapperEl.hidden = true;
        if (ytFallbackBadge) ytFallbackBadge.hidden = false;
      }
    },
  });

  const audioEngine = createAudioEngine({
    instrumentalVolume: initInstVol,
    vocalsVolume: initVocVol,
    onStateChange: (engineState) => {
      if (disposed) return;
      const isPlaying = engineState === "playing";
      toggleBtn.textContent = isPlaying ? t("play.pauseBtn") : t("play.playBtn");

      if (isPlaying) {
        requestWakeLock();
      } else {
        releaseWakeLock();
        youtubePlayer.syncToMaster(audioEngine.getCurrentTime(), false);
      }

      if (engineState === "ended") {
        finishSong();
      }
    },
    onTimeUpdate: (current, total) => {
      if (disposed) return;
      timeCurrentEl.textContent = formatClock(current);
      if (!isSeekingSlider && total > 0) {
        timelineSlider.value = String(current);
      }
      renderLyricsFrame(current);
      if (videoEnabled) {
        youtubePlayer.syncToMaster(current, audioEngine.getState() === "playing");
      }
      if (total > 0 && current >= total - 0.05 && audioEngine.getState() === "playing") {
        finishSong();
      }
    },
  });

  const pitchLane = createPitchLane(pitchLaneWrapper, {
    getCurrentTime: () => audioEngine.getCurrentTime(),
    pitchConfThreshold,
    latencyOffsetMs: currentLatencyMs,
    difficulty: currentDifficulty,
    visualSnapConfig: cfgVisualSnap,
  });

  function initOrResetSession() {
    gameSession = createGameSession({
      modeId: "standard",
      player: getState().player,
      song: {
        videoId,
        title: manifestData?.source?.title || videoId,
        artist: manifestData?.source?.channel || "",
        duration: songDurationSec || Number(manifestData?.source?.duration) || 0,
        compatibilityLevel: manifestData?.compatibility?.level || "regular",
      },
      difficulty: currentDifficulty,
      assists: {
        autoTranspose: Boolean(prefs.autoTranspose),
        guideVolume: Number(vocSlider?.value || initVocVol),
      },
      prefs,
    });
    gameSession.start();
  }

  function buildScoringEngine() {
    const lyricWindows = lyricSync.getLyricWindows({
      paddingSeconds: lyricWindowPadding,
      songDurationSeconds: songDurationSec || Number(manifestData?.source?.duration) || null,
    });

    scoringEngine = createScoringEngine({
      pitchMap: pitchMapData,
      difficulty: currentDifficulty,
      tolerances: cfgTolerances,
      scoringWeights: cfgScoringWeights,
      autoTransposeByDifficulty: cfgAutoTransposeMap,
      lyricWindows,
      pitchConfThreshold,
      latencyOffsetMs: currentLatencyMs,
      autoTranspose: prefs.autoTranspose,
      heuristicConfig: cfgHeuristic,
    });
    initOrResetSession();
    if (liveScoreEl) liveScoreEl.textContent = "0.0";
    if (liveStreakEl) liveStreakEl.textContent = "0";
  }

  function updateHitFeedback(hit) {
    if (!hitBadgeEl) return;
    hitBadgeEl.className = "hit-badge";
    if (hit === "perfect") {
      hitBadgeEl.classList.add("perfect");
      hitBadgeEl.textContent = t("play.hitPerfect");
    } else if (hit === "good") {
      hitBadgeEl.classList.add("good");
      hitBadgeEl.textContent = t("play.hitGood");
    } else if (hit === "miss") {
      hitBadgeEl.classList.add("miss");
      hitBadgeEl.textContent = t("play.hitMiss");
    } else {
      hitBadgeEl.textContent = t("play.hitIdle");
    }
  }

  function renderLyricsFrame(currentTimeSeconds) {
    if (pitchMapData?.mode === "heuristic") {
      if (lastRenderedLineIndex !== -30) {
        lastRenderedLineIndex = -30;
        lyricsOverlayEl.replaceChildren();
        const badge = document.createElement("span");
        badge.className = "pill";
        badge.textContent = "Modo instrumental / karaokê";
        const msg = document.createElement("div");
        msg.className = "muted";
        msg.textContent = "Letra externa desativada: acompanhe o vídeo ou cante livremente.";
        lyricsOverlayEl.append(badge, msg);
      }
      return;
    }

    const syncState = lyricSync.getStateAt(currentTimeSeconds);

    if (syncState.mode === "none") {
      if (lastRenderedLineIndex !== -10) {
        lastRenderedLineIndex = -10;
        lyricsOverlayEl.replaceChildren();
        const msg = document.createElement("div");
        msg.className = "muted";
        msg.textContent = t("play.instrumentalMode");
        lyricsOverlayEl.appendChild(msg);
      }
      return;
    }

    if (syncState.mode === "plain") {
      if (lastRenderedLineIndex !== -20) {
        lastRenderedLineIndex = -20;
        lyricsOverlayEl.replaceChildren();
        const badge = document.createElement("span");
        badge.className = "pill";
        badge.textContent = t("play.plainLyricsBadge");

        const box = document.createElement("div");
        box.className = "plain-lyrics-box";
        for (const line of syncState.lines) {
          const row = document.createElement("div");
          row.textContent = line.text;
          box.appendChild(row);
        }
        lyricsOverlayEl.append(badge, box);
      }
      return;
    }

    const idx = syncState.currentIndex;
    if (idx !== lastRenderedLineIndex) {
      lastRenderedLineIndex = idx;
      const prevText = idx > 0 ? syncState.lines[idx - 1]?.text || "" : "";
      const currText = syncState.currentLine
        ? syncState.currentLine.text
        : t("play.waitingIntro");
      const nextText = syncState.nextLine ? syncState.nextLine.text : "";

      lyricsOverlayEl.replaceChildren();

      const prevEl = document.createElement("div");
      prevEl.className = "lyric-prev";
      prevEl.textContent = prevText;

      const currEl = document.createElement("div");
      currEl.className = "lyric-current";
      currEl.textContent = currText;

      const progTrack = document.createElement("div");
      progTrack.className = "lyric-line-progress";
      const progFill = document.createElement("div");
      progFill.id = "lyric-progress-fill";
      progFill.className = "lyric-line-progress-fill";
      progTrack.appendChild(progFill);

      const nextEl = document.createElement("div");
      nextEl.className = "lyric-next";
      nextEl.textContent = nextText;

      lyricsOverlayEl.append(prevEl, currEl, progTrack, nextEl);
    }

    const fillEl = lyricsOverlayEl.querySelector("#lyric-progress-fill");
    if (fillEl) {
      fillEl.style.width = `${Math.round(syncState.lineProgress * 100)}%`;
    }
  }

  function checkSpeakerBleed(songTime, frame) {
    if (bleedWarningDismissed || !pitchMapData || !Array.isArray(pitchMapData.midi)) return;
    const hop = Number(pitchMapData.hop) > 0 ? Number(pitchMapData.hop) : 0.02;
    const idx = Math.round((songTime - Number(pitchMapData.t0 ?? 0)) / hop);
    if (idx < 0 || idx >= pitchMapData.midi.length) return;

    const isUnvoicedRef = pitchMapData.midi[idx] === null;
    const highRms = Number(frame.rms) > Number(audioSettings.rmsThreshold || 0.01) * 2.2;
    const lowClarity = !frame.voiced;

    if (isUnvoicedRef && highRms && lowClarity) {
      unvoicedBleedAccumSec += 0.025;
      if (unvoicedBleedAccumSec >= 3.0) {
        showStageAlert("Use fones de ouvido para uma pontuação mais justa.");
        unvoicedBleedAccumSec = 0;
      }
    } else {
      unvoicedBleedAccumSec = Math.max(0, unvoicedBleedAccumSec - 0.05);
    }
  }

  const micCapture = createMicCapture({
    inputGain: audioSettings.inputGain,
    rmsThreshold: audioSettings.rmsThreshold,
    onStateChange: (isActive) => {
      if (disposed) return;
      if (isActive) {
        micBtn.textContent = t("play.micOnBtn");
        micBtn.className = "btn btn-primary";
      } else {
        micBtn.textContent = t("play.micOffBtn");
        micBtn.className = "btn btn-secondary";
        sungNoteEl.textContent = "--";
        micMeter.update({ rms: 0, clarity: 0, midi: null });
        updateHitFeedback(null);
      }
    },
    onPitch: (frame) => {
      if (disposed) return;
      const hasVoice = Boolean(frame.voiced && frame.midi !== null && Number.isFinite(frame.midi));
      micMeter.update({
        rms: frame.rms,
        clarity: frame.clarity,
        midi: hasVoice ? frame.midi : null,
      });

      const songTime = audioEngine.getCurrentTime();
      const isPlaying = audioEngine.getState() === "playing";

      if (isPlaying) {
        checkSpeakerBleed(songTime, frame);
      }

      if (!hasVoice) {
        sungNoteEl.textContent = "--";
        updateHitFeedback(null);
        if (isPlaying && scoringEngine) {
          const evalRes = scoringEngine.pushFrame({ songTime, midi: null });
          gameSession?.pushFrame(evalRes);
          pitchLane.pushUserFrame({ songTime, midi: null, hit: null });
        }
        return;
      }

      sungNoteEl.textContent = midiToNoteName(frame.midi);

      if (isPlaying && scoringEngine) {
        const evalRes = scoringEngine.pushFrame({ songTime, midi: frame.midi });
        const frameState = gameSession?.pushFrame(evalRes);
        updateHitFeedback(evalRes.hit);
        pitchLane.pushUserFrame({ songTime, midi: frame.midi, hit: evalRes.hit });

        if (frameState && liveStreakEl) {
          liveStreakEl.textContent = String(frameState.bestStreak ?? 0);
        }

        // Atualiza nota parcial apenas se o usuário habilitou explicitamente nas Configurações
        if (prefs.showPartialScore && liveScoreEl) {
          const snap = scoringEngine.summary();
          liveScoreEl.textContent = snap.score.toFixed(1);
        }
      } else {
        pitchLane.pushUserFrame({ songTime, midi: frame.midi, hit: null });
      }
    },
  });

  async function tryEnableMic(silentOnFail = false) {
    try {
      await micCapture.start({
        deviceId: audioSettings.micDeviceId || undefined,
      });
    } catch (err) {
      if (!disposed) {
        micMeter.setError("Sem microfone");
        if (!silentOnFail) {
          showBanner("warning", `${t("play.micUnavailable")}: ${err.message}`);
        }
      }
    }
  }

  function handleDeviceChange() {
    if (disposed) return;
    if (audioEngine.getState() === "playing" && micCapture.isActive()) {
      audioEngine.pause();
      openPauseMenu();
      showStageAlert("Dispositivo de áudio alterado. Verifique seu microfone antes de continuar.");
    }
  }

  navigator.mediaDevices?.addEventListener?.("devicechange", handleDeviceChange);

  function stopCountdown() {
    if (countdownTimerId !== null) {
      clearInterval(countdownTimerId);
      countdownTimerId = null;
    }
    countdownOverlay.hidden = true;
  }

  function startCountdownAndPlay() {
    stopCountdown();
    const totalCount = Math.max(0, Number(prefs.countdownSeconds ?? 3));
    if (totalCount === 0) {
      audioEngine.play().catch((err) => showBanner("error", err.message));
      return;
    }

    let remaining = totalCount;
    countdownNumberEl.textContent = String(remaining);
    countdownOverlay.hidden = false;

    countdownTimerId = setInterval(() => {
      if (disposed) {
        stopCountdown();
        return;
      }
      remaining -= 1;
      if (remaining > 0) {
        countdownNumberEl.textContent = String(remaining);
      } else {
        stopCountdown();
        audioEngine.play().catch((err) => showBanner("error", err.message));
      }
    }, 1000);
  }

  countdownSkipBtn?.addEventListener("click", () => {
    stopCountdown();
    audioEngine.play().catch((err) => showBanner("error", err.message));
  });

  function openPauseMenu() {
    if (pauseMenuOpen) return;
    stopCountdown();
    if (audioEngine.getState() === "playing") {
      audioEngine.pause();
    }
    pauseMenuOpen = true;
    pauseOffsetVal.textContent = `${lyricSync.getOffsetMs()} ms`;
    pauseLatVal.textContent = `${currentLatencyMs} ms`;
    pauseOverlay.hidden = false;
  }

  function closePauseMenu(resumePlay = false) {
    if (!pauseMenuOpen) return;
    pauseMenuOpen = false;
    pauseOverlay.hidden = true;
    if (resumePlay && !songFinished) {
      audioEngine.play().catch((err) => showBanner("error", err.message));
    }
  }

  pauseMenuBtn?.addEventListener("click", () => {
    if (pauseMenuOpen) {
      closePauseMenu(false);
    } else {
      openPauseMenu();
    }
  });

  pauseResumeBtn?.addEventListener("click", () => closePauseMenu(true));

  function updateLyricsOffset(deltaMs) {
    const next = lyricSync.setOffsetMs(lyricSync.getOffsetMs() + deltaMs);
    offsetLabelEl.textContent = `${next} ms`;
    pauseOffsetVal.textContent = `${next} ms`;
    lastRenderedLineIndex = -999;
    renderLyricsFrame(audioEngine.getCurrentTime());
    api.patchSong(videoId, { lyrics: { offset_ms: next } }).catch(() => {
      showStageAlert("Sem conexão com o servidor local: ajuste salvo apenas nesta partida.");
    });
  }

  function updateLatencyOffset(deltaMs) {
    currentLatencyMs = Math.max(-300, Math.min(500, currentLatencyMs + deltaMs));
    latencyChipEl.textContent = `${currentLatencyMs} ms`;
    pauseLatVal.textContent = `${currentLatencyMs} ms`;
    pitchLane.setLatencyOffset(currentLatencyMs);
    if (scoringEngine) {
      const snap = scoringEngine.summary();
      if (snap.coverage === 0) {
        buildScoringEngine();
      }
    }
  }

  offsetMinusBtn?.addEventListener("click", () => updateLyricsOffset(-100));
  offsetPlusBtn?.addEventListener("click", () => updateLyricsOffset(100));
  pauseOffsetMinus?.addEventListener("click", () => updateLyricsOffset(-100));
  pauseOffsetPlus?.addEventListener("click", () => updateLyricsOffset(100));

  pauseLatMinus?.addEventListener("click", () => updateLatencyOffset(-10));
  pauseLatPlus?.addEventListener("click", () => updateLatencyOffset(10));

  pauseVocalsSlider?.addEventListener("input", () => {
    const val = Number(pauseVocalsSlider.value);
    pauseVocalsVal.textContent = `${Math.round(val * 100)}%`;
    vocSlider.value = String(val);
    vocValEl.textContent = `${Math.round(val * 100)}%`;
    audioEngine.setStemVolumes({ vocals: val });
    if (gameSession?.getState()?.assists) {
      gameSession.getState().assists.guideVolume = val;
    }
  });

  pauseVideoToggle?.addEventListener("click", () => {
    videoEnabled = !videoEnabled;
    videoWrapperEl.hidden = !videoEnabled;
    pauseVideoToggle.textContent = videoEnabled ? "Ocultar vídeo" : "Mostrar vídeo";
    if (videoEnabled) {
      youtubePlayer.syncToMaster(audioEngine.getCurrentTime(), audioEngine.getState() === "playing");
    }
  });

  async function restartMatch() {
    stopCountdown();
    closePauseMenu(false);
    songFinished = false;
    await audioEngine.seek(0);
    youtubePlayer.forceSeek(0);
    buildScoringEngine();
    pitchLane.setDifficulty(currentDifficulty);
    pitchLane.setPitchMap(pitchMapData);
    lastRenderedLineIndex = -999;
    renderLyricsFrame(0);
    startCountdownAndPlay();
  }

  pauseRestartBtn?.addEventListener("click", restartMatch);
  restartBtn?.addEventListener("click", restartMatch);

  pauseSettingsBtn?.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Ir para Configurações",
      message: "Sair da partida atual para abrir as configurações de áudio?",
      danger: false,
    });
    if (ok) navigate("/settings");
  });

  async function requestExitToHome() {
    const st = audioEngine.getState();
    if (st === "playing" || st === "paused" || pauseMenuOpen) {
      const ok = await confirmDialog({
        title: t("play.leaveTitle"),
        message: t("play.leaveMsg"),
        danger: true,
      });
      if (!ok) return;

      if (gameSession && prefs.recordAbandoned && scoringEngine) {
        try {
          await gameSession.abort({
            summary: scoringEngine.summary(),
            durationSeconds: Math.round(audioEngine.getCurrentTime() || 0),
            micDeviceId: audioSettings.micDeviceId,
          });
        } catch {
          // Ignora falha ao gravar partida abandonada
        }
      }
    }
    navigate("/");
  }

  exitBtn?.addEventListener("click", requestExitToHome);
  pauseExitBtn?.addEventListener("click", requestExitToHome);

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      playShellEl?.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  fullscreenBtn?.addEventListener("click", toggleFullscreen);

  function handleKeyDown(ev) {
    if (disposed) return;
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

    if (ev.code === "Space") {
      ev.preventDefault();
      if (pauseMenuOpen) {
        closePauseMenu(true);
      } else if (audioEngine.getState() === "playing") {
        audioEngine.pause();
      } else if (!toggleBtn.disabled) {
        audioEngine.play().catch((err) => showBanner("error", err.message));
      }
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      if (pauseMenuOpen) {
        closePauseMenu(true);
      } else {
        openPauseMenu();
      }
    } else if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen();
    } else if (pauseMenuOpen && ev.key === "ArrowLeft") {
      ev.preventDefault();
      updateLyricsOffset(-100);
    } else if (pauseMenuOpen && ev.key === "ArrowRight") {
      ev.preventDefault();
      updateLyricsOffset(100);
    }
  }

  window.addEventListener("keydown", handleKeyDown);

  // Finalização da música via abstração de modos e transição para Tela de Resultado
  async function finishSong() {
    if (songFinished || disposed) return;
    songFinished = true;
    stopCountdown();
    releaseWakeLock();

    const summary = scoringEngine
      ? scoringEngine.summary()
      : {
          score: 0.0,
          pitch_score: 0.0,
          lyric_score: 0.0,
          best_streak: 0,
          coverage: 0,
          scoring_confidence: "low",
          segments: [],
          transposition_semitones: 0,
        };

    if (!gameSession) {
      initOrResetSession();
    }

    if (gameSession?.getState()?.assists) {
      gameSession.getState().assists.guideVolume = Number(vocSlider.value || 0);
    }

    let entryId = "";
    try {
      const outcome = await gameSession.finish({
        summary,
        durationSeconds: Math.round(songDurationSec || Number(manifestData?.source?.duration) || 0),
        micDeviceId: audioSettings.micDeviceId,
      });
      entryId = outcome.entry.id;
    } catch (err) {
      showBanner("warning", `Não foi possível enviar o histórico agora: ${err.message}`);
      entryId = getState().lastResultEntry?.id || `res_${Date.now()}`;
    }

    if (!disposed) {
      navigate(`/result/${encodeURIComponent(entryId)}`);
    }
  }

  micBtn?.addEventListener("click", async () => {
    if (micCapture.isActive()) {
      await micCapture.stop();
    } else {
      await tryEnableMic(false);
    }
  });

  toggleBtn?.addEventListener("click", async () => {
    try {
      if (audioEngine.getState() === "playing") {
        audioEngine.pause();
      } else {
        closePauseMenu(false);
        await audioEngine.play();
      }
    } catch (err) {
      showBanner("error", err.message);
    }
  });

  timelineSlider?.addEventListener("input", () => {
    isSeekingSlider = true;
    const target = Number(timelineSlider.value);
    timeCurrentEl.textContent = formatClock(target);
    renderLyricsFrame(target);
  });

  timelineSlider?.addEventListener("change", async () => {
    const target = Number(timelineSlider.value);
    isSeekingSlider = false;
    await audioEngine.seek(target);
    youtubePlayer.forceSeek(target);
    lastRenderedLineIndex = -999;
    renderLyricsFrame(target);
  });

  instSlider?.addEventListener("input", () => {
    const val = Number(instSlider.value);
    instValEl.textContent = `${Math.round(val * 100)}%`;
    audioEngine.setStemVolumes({ instrumental: val });
  });

  vocSlider?.addEventListener("input", () => {
    const val = Number(vocSlider.value);
    vocValEl.textContent = `${Math.round(val * 100)}%`;
    pauseVocalsSlider.value = String(val);
    pauseVocalsVal.textContent = `${Math.round(val * 100)}%`;
    audioEngine.setStemVolumes({ vocals: val });
    if (gameSession?.getState()?.assists) {
      gameSession.getState().assists.guideVolume = val;
    }
  });

  async function initStage() {
    try {
      const [songData, loadedPitchMap] = await Promise.all([
        api.getSong(videoId),
        fetchPitchMap(videoId).catch(() => null),
      ]);

      if (disposed) return;

      manifestData = songData.manifest;
      pitchMapData = loadedPitchMap;

      titleEl.textContent = manifestData.source?.title || videoId;
      channelEl.textContent = manifestData.source?.channel || "";

      // Carrega a letra sincronizada ANTES de criar o motor de notas para gerar as janelas ativas
      const lyrics = songData.lyrics;
      lyricSync.loadFromSongData(lyrics, manifestData.lyrics || {});
      const initialOffset = lyricSync.getOffsetMs();
      offsetLabelEl.textContent = `${initialOffset} ms`;
      pauseOffsetVal.textContent = `${initialOffset} ms`;

      buildScoringEngine();
      pitchLane.setPitchMap(pitchMapData);

      if (
        pitchMapData?.mode !== "heuristic" &&
        lyrics &&
        Array.isArray(lyrics.candidates) &&
        lyrics.candidates.length > 0
      ) {
        lyricsToolsEl.hidden = false;
        lyricsSelectEl.replaceChildren();
        const activeId = lyricSync.getMetadata().activeCandidateId;

        for (const c of lyrics.candidates) {
          const opt = document.createElement("option");
          const tag = c.syncedLyrics ? "LRC" : "TXT";
          const dur = c.duration ? ` (${formatClock(c.duration)})` : "";
          opt.value = String(c.id);
          opt.textContent = `[${tag}] ${c.artistName || ""} - ${c.trackName || ""}${dur}`;
          if (c.id === activeId) opt.selected = true;
          lyricsSelectEl.appendChild(opt);
        }

        lyricsSelectEl.addEventListener("change", () => {
          const chosenId = Number(lyricsSelectEl.value);
          const chosen = lyrics.candidates.find((c) => c.id === chosenId) || null;
          lyricSync.loadCandidate(chosen);
          buildScoringEngine();
          lastRenderedLineIndex = -999;
          renderLyricsFrame(audioEngine.getCurrentTime());
          api.patchSong(videoId, { selected_id: chosenId }).catch(() => {});
        });
      }

      const ytPromise = videoEnabled ? youtubePlayer.init(ytTargetEl, videoId) : Promise.resolve();
      const { duration } = await audioEngine.loadSong(videoId);
      await ytPromise;

      if (disposed) return;

      songDurationSec = duration;
      if (gameSession?.getState()?.song) {
        gameSession.getState().song.duration = Math.round(duration);
      }
      timelineSlider.max = String(duration);
      timelineSlider.disabled = false;
      timeTotalEl.textContent = formatClock(duration);
      toggleBtn.disabled = false;
      restartBtn.disabled = false;

      lastRenderedLineIndex = -999;
      renderLyricsFrame(0);
      pitchLane.start();

      await tryEnableMic(true);
      startCountdownAndPlay();
    } catch (err) {
      if (!disposed) {
        showBanner("error", err.message);
        channelEl.textContent = err.message;
      }
    }
  }

  initStage();

  return () => {
    disposed = true;
    stopCountdown();
    releaseWakeLock();
    window.removeEventListener("keydown", handleKeyDown);
    navigator.mediaDevices?.removeEventListener?.("devicechange", handleDeviceChange);
    pitchLane.destroy();
    micMeter.destroy();
    micCapture.stop();
    audioEngine.destroy();
    youtubePlayer.destroy();
  };
}