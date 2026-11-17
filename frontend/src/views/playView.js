/**
 * Tela de Jogo v2 (#/play/:videoId):
 * AudioEngine + LyricSync + YouTubePlayer + MicCapture + PitchRollCanvas (T2.4).
 */

import { api } from "../api.js";
import { createAudioEngine } from "../audio/audioEngine.js";
import { createMicCapture } from "../audio/micCapture.js";
import { loadPitchReference } from "../audio/pitchReference.js";
import { midiToNoteName } from "../audio/yinDetector.js";
import { t } from "../i18n.js";
import { createLyricSync } from "../player/lyricSync.js";
import { createPitchRollCanvas } from "../player/pitchRollCanvas.js";
import { createYouTubePlayer } from "../player/youtubePlayer.js";
import { navigate } from "../router.js";
import { getAudioSettings, getState, showBanner } from "../store.js";
import { confirmDialog } from "../ui/confirmModal.js";

function formatClock(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function rmsToMeterPercent(rms) {
  const clamped = Math.max(0, Math.min(0.4, Number(rms) || 0));
  return Math.min(100, Math.max(0, Math.sqrt(clamped / 0.35) * 100));
}

export function renderPlayView(container, params) {
  const { videoId } = params;
  const audioSettings = getAudioSettings();

  let disposed = false;
  let isSeekingSlider = false;
  let lastRenderedLineIndex = -999;
  let pitchReference = null;
  let renderRafId = null;

  const initInstVol = audioSettings.defaultInstrumentalVol;
  const initVocVol = audioSettings.defaultVocalsVol;

  container.innerHTML = `
    <div class="play-shell">
      <div class="play-topbar">
        <div style="display: flex; align-items: center; gap: 0.85rem;">
          <button type="button" id="play-exit-btn" class="btn btn-secondary">
            ← ${t("play.backBtn")}
          </button>
          <div class="play-song-info">
            <h2 id="play-title" class="play-song-title">${videoId}</h2>
            <span id="play-channel" class="muted" style="font-size: 0.85rem;">${t("play.loadingAudio")}</span>
          </div>
        </div>

        <div class="play-lyrics-tools" id="play-lyrics-tools" hidden>
          <select id="play-lyrics-select" class="select-control" aria-label="${t("play.lyricsSelectLabel")}"></select>
          <button type="button" id="play-offset-minus" class="btn btn-secondary" title="-100ms">-100ms</button>
          <span id="play-offset-label" class="mono" style="font-size: 0.85rem;">0 ms</span>
          <button type="button" id="play-offset-plus" class="btn btn-secondary" title="+100ms">+100ms</button>
        </div>
      </div>

      <div class="vocal-hud-bar">
        <div class="vocal-hud-left">
          <button type="button" id="play-mic-btn" class="btn btn-secondary">
            ${t("play.micOffBtn")}
          </button>
          <div class="stage-vu-track" title="Sinal do microfone">
            <div id="play-vu-fill" class="stage-vu-fill"></div>
          </div>
          <span id="play-latency-chip" class="mono muted" style="font-size: 0.8rem;">
            ${audioSettings.micLatencyMs} ms
          </span>
        </div>

        <div class="vocal-hud-right">
          <span id="play-sung-note" class="stage-note-pill">--</span>
          <span id="play-hit-badge" class="hit-badge">${t("play.hitIdle")}</span>
        </div>
      </div>

      <section class="stage-arena">
        <div class="stage-video-wrapper">
          <div id="yt-player-target"></div>
        </div>
        <div id="yt-fallback-badge" class="stage-video-fallback" hidden>
          ${t("play.videoUnavailable")}
        </div>

        <div class="pitch-roll-wrapper">
          <canvas id="pitch-roll-canvas" class="pitch-roll-canvas"></canvas>
        </div>

        <div id="lyrics-overlay" class="lyrics-overlay">
          <div class="lyric-current">${t("play.loadingAudio")}</div>
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

  const exitBtn = container.querySelector("#play-exit-btn");
  const titleEl = container.querySelector("#play-title");
  const channelEl = container.querySelector("#play-channel");
  const lyricsToolsEl = container.querySelector("#play-lyrics-tools");
  const lyricsSelectEl = container.querySelector("#play-lyrics-select");
  const offsetMinusBtn = container.querySelector("#play-offset-minus");
  const offsetPlusBtn = container.querySelector("#play-offset-plus");
  const offsetLabelEl = container.querySelector("#play-offset-label");

  const micBtn = container.querySelector("#play-mic-btn");
  const vuFillEl = container.querySelector("#play-vu-fill");
  const sungNoteEl = container.querySelector("#play-sung-note");
  const hitBadgeEl = container.querySelector("#play-hit-badge");

  const ytTargetEl = container.querySelector("#yt-player-target");
  const ytFallbackBadge = container.querySelector("#yt-fallback-badge");
  const pitchCanvasEl = container.querySelector("#pitch-roll-canvas");
  const lyricsOverlayEl = container.querySelector("#lyrics-overlay");

  const timeCurrentEl = container.querySelector("#play-time-current");
  const timeTotalEl = container.querySelector("#play-time-total");
  const timelineSlider = container.querySelector("#play-timeline");
  const toggleBtn = container.querySelector("#play-toggle-btn");
  const restartBtn = container.querySelector("#play-restart-btn");

  const instSlider = container.querySelector("#vol-instrumental");
  const instValEl = container.querySelector("#vol-instrumental-val");
  const vocSlider = container.querySelector("#vol-vocals");
  const vocValEl = container.querySelector("#vol-vocals-val");

  const cfgAudio = getState().config?.audio || {};

  const lyricSync = createLyricSync();
  const pitchRoll = createPitchRollCanvas(pitchCanvasEl, {
    emptyMessage: t("play.noPitchData"),
  });

  const youtubePlayer = createYouTubePlayer({
    driftThresholdSeconds: Number(cfgAudio.youtube_drift_threshold_seconds ?? 0.45),
    onUnavailable: () => {
      if (!disposed && ytFallbackBadge) {
        ytFallbackBadge.hidden = false;
      }
    },
  });

  function updateHitFeedback(status) {
    if (!hitBadgeEl) return;
    hitBadgeEl.className = "hit-badge";
    if (status === "perfect") {
      hitBadgeEl.classList.add("perfect");
      hitBadgeEl.textContent = t("play.hitPerfect");
    } else if (status === "great") {
      hitBadgeEl.classList.add("great");
      hitBadgeEl.textContent = t("play.hitGreat");
    } else if (status === "good") {
      hitBadgeEl.classList.add("good");
      hitBadgeEl.textContent = t("play.hitGood");
    } else if (status === "miss") {
      hitBadgeEl.classList.add("miss");
      hitBadgeEl.textContent = t("play.hitMiss");
    } else if (status === "rest") {
      hitBadgeEl.textContent = t("play.hitFree");
    } else {
      hitBadgeEl.textContent = t("play.hitIdle");
    }
  }

  function renderLyricsFrame(currentTimeSeconds) {
    const syncState = lyricSync.getStateAt(currentTimeSeconds);

    if (syncState.mode === "none") {
      if (lastRenderedLineIndex !== -10) {
        lastRenderedLineIndex = -10;
        lyricsOverlayEl.innerHTML = `
          <div class="muted">${t("play.instrumentalMode")}</div>
        `;
      }
      return;
    }

    if (syncState.mode === "plain") {
      if (lastRenderedLineIndex !== -20) {
        lastRenderedLineIndex = -20;
        const htmlLines = syncState.lines
          .map((l) => `<div>${escapeHtml(l.text)}</div>`)
          .join("");
        lyricsOverlayEl.innerHTML = `
          <span class="pill">${t("play.plainLyricsBadge")}</span>
          <div class="plain-lyrics-box">${htmlLines}</div>
        `;
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

      lyricsOverlayEl.innerHTML = `
        <div class="lyric-prev">${escapeHtml(prevText)}</div>
        <div class="lyric-current">${escapeHtml(currText)}</div>
        <div class="lyric-line-progress">
          <div id="lyric-progress-fill" class="lyric-line-progress-fill"></div>
        </div>
        <div class="lyric-next">${escapeHtml(nextText)}</div>
      `;
    }

    const fillEl = lyricsOverlayEl.querySelector("#lyric-progress-fill");
    if (fillEl) {
      fillEl.style.width = `${Math.round(syncState.lineProgress * 100)}%`;
    }
  }

  const audioEngine = createAudioEngine({
    instrumentalVolume: initInstVol,
    vocalsVolume: initVocVol,
    onStateChange: (engineState) => {
      if (disposed) return;
      toggleBtn.textContent = engineState === "playing" ? t("play.pauseBtn") : t("play.playBtn");

      if (engineState === "paused" || engineState === "stopped" || engineState === "ended") {
        youtubePlayer.syncToMaster(audioEngine.getCurrentTime(), false);
        pitchRoll.render(audioEngine.getCurrentTime());
      }
    },
    onTimeUpdate: (current, total) => {
      if (disposed) return;
      timeCurrentEl.textContent = formatClock(current);
      if (!isSeekingSlider && total > 0) {
        timelineSlider.value = String(current);
      }
      renderLyricsFrame(current);
      pitchRoll.render(current);
      youtubePlayer.syncToMaster(current, audioEngine.getState() === "playing");
    },
  });

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
        vuFillEl.style.width = "0%";
        sungNoteEl.textContent = "--";
        updateHitFeedback("silent");
      }
    },
    onPitch: (frame) => {
      if (disposed) return;
      vuFillEl.style.width = `${rmsToMeterPercent(frame.rms)}%`;

      if (!frame.voiced || frame.midi === null) {
        sungNoteEl.textContent = "--";
        updateHitFeedback("silent");
        return;
      }

      sungNoteEl.textContent = midiToNoteName(frame.midi);
      const songTime = audioEngine.getCurrentTime();
      const isPlaying = audioEngine.getState() === "playing";

      if (pitchReference) {
        const evalRes = pitchReference.evaluateSungPitch({
          songTimeSeconds: songTime,
          userMidi: frame.midi,
          micLatencyMs: audioSettings.micLatencyMs,
          octaveTolerant: true,
        });

        updateHitFeedback(evalRes.status);

        if (isPlaying) {
          pitchRoll.pushUserPoint({
            time: evalRes.effectiveTime,
            midi: evalRes.displayUserMidi ?? frame.midi,
            status: evalRes.status,
          });
        }
      } else {
        updateHitFeedback("rest");
      }
    },
  });

  async function tryEnableMic(silentOnFail = false) {
    try {
      await micCapture.start({
        deviceId: audioSettings.micDeviceId || undefined,
      });
    } catch (err) {
      if (!silentOnFail && !disposed) {
        showBanner("warning", `${t("play.micUnavailable")}: ${err.message}`);
      }
    }
  }

  micBtn?.addEventListener("click", async () => {
    if (micCapture.isActive()) {
      await micCapture.stop();
    } else {
      await tryEnableMic(false);
    }
  });

  exitBtn?.addEventListener("click", async () => {
    const st = audioEngine.getState();
    if (st === "playing" || st === "paused") {
      const ok = await confirmDialog({
        title: t("play.leaveTitle"),
        message: t("play.leaveMsg"),
        danger: true,
      });
      if (!ok) return;
    }
    navigate("/");
  });

  toggleBtn?.addEventListener("click", async () => {
    try {
      if (audioEngine.getState() === "playing") {
        audioEngine.pause();
      } else {
        await audioEngine.play();
      }
    } catch (err) {
      showBanner("error", err.message);
    }
  });

  restartBtn?.addEventListener("click", async () => {
    await audioEngine.seek(0);
    youtubePlayer.forceSeek(0);
    pitchRoll.clearTrail();
    pitchRoll.render(0);
    lastRenderedLineIndex = -999;
    renderLyricsFrame(0);
  });

  timelineSlider?.addEventListener("input", () => {
    isSeekingSlider = true;
    const target = Number(timelineSlider.value);
    timeCurrentEl.textContent = formatClock(target);
    renderLyricsFrame(target);
    pitchRoll.render(target);
  });

  timelineSlider?.addEventListener("change", async () => {
    const target = Number(timelineSlider.value);
    isSeekingSlider = false;
    await audioEngine.seek(target);
    youtubePlayer.forceSeek(target);
    pitchRoll.clearTrail();
    pitchRoll.render(target);
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
    audioEngine.setStemVolumes({ vocals: val });
  });

  async function saveLyricsPatch(patch) {
    try {
      await api.patchSong(videoId, patch);
    } catch (err) {
      showBanner("warning", err.message);
    }
  }

  offsetMinusBtn?.addEventListener("click", () => {
    const next = lyricSync.setOffsetMs(lyricSync.getOffsetMs() - 100);
    offsetLabelEl.textContent = `${next} ms`;
    lastRenderedLineIndex = -999;
    renderLyricsFrame(audioEngine.getCurrentTime());
    saveLyricsPatch({ offset_ms: next });
  });

  offsetPlusBtn?.addEventListener("click", () => {
    const next = lyricSync.setOffsetMs(lyricSync.getOffsetMs() + 100);
    offsetLabelEl.textContent = `${next} ms`;
    lastRenderedLineIndex = -999;
    renderLyricsFrame(audioEngine.getCurrentTime());
    saveLyricsPatch({ offset_ms: next });
  });

  function startCanvasIdleLoop() {
    const loop = () => {
      if (disposed) return;
      if (audioEngine.getState() !== "playing") {
        pitchRoll.render(audioEngine.getCurrentTime());
      }
      renderRafId = requestAnimationFrame(loop);
    };
    renderRafId = requestAnimationFrame(loop);
  }

  async function initStage() {
    try {
      const [songData, loadedPitchRef] = await Promise.all([
        api.getSong(videoId),
        loadPitchReference(videoId).catch(() => null),
      ]);

      if (disposed) return;

      pitchReference = loadedPitchRef;
      pitchRoll.setPitchReference(pitchReference, t("play.noPitchData"));

      const { manifest, lyrics } = songData;
      titleEl.textContent = manifest.source?.title || videoId;
      channelEl.textContent = manifest.source?.channel || "";

      lyricSync.loadFromSongData(lyrics, manifest.lyrics || {});
      offsetLabelEl.textContent = `${lyricSync.getOffsetMs()} ms`;

      if (lyrics && Array.isArray(lyrics.candidates) && lyrics.candidates.length > 0) {
        lyricsToolsEl.hidden = false;
        lyricsSelectEl.innerHTML = lyrics.candidates
          .map((c) => {
            const tag = c.syncedLyrics ? "LRC" : "TXT";
            const dur = c.duration ? ` (${formatClock(c.duration)})` : "";
            const label = `[${tag}] ${c.artistName || ""} - ${c.trackName || ""}${dur}`;
            const selected = c.id === lyricSync.getMetadata().activeCandidateId ? "selected" : "";
            return `<option value="${c.id}" ${selected}>${escapeHtml(label)}</option>`;
          })
          .join("");

        lyricsSelectEl.addEventListener("change", () => {
          const chosenId = Number(lyricsSelectEl.value);
          const chosen = lyrics.candidates.find((c) => c.id === chosenId) || null;
          lyricSync.loadCandidate(chosen);
          lastRenderedLineIndex = -999;
          renderLyricsFrame(audioEngine.getCurrentTime());
          saveLyricsPatch({ selected_id: chosenId });
        });
      }

      const ytPromise = youtubePlayer.init(ytTargetEl, videoId);
      const { duration } = await audioEngine.loadSong(videoId);
      await ytPromise;

      if (disposed) return;

      timelineSlider.max = String(duration);
      timelineSlider.disabled = false;
      timeTotalEl.textContent = formatClock(duration);
      toggleBtn.disabled = false;
      restartBtn.disabled = false;

      lastRenderedLineIndex = -999;
      renderLyricsFrame(0);
      pitchRoll.render(0);
      startCanvasIdleLoop();

      // Tenta ativar o microfone automaticamente sem bloquear o palco caso não haja permissão
      await tryEnableMic(true);
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
    if (renderRafId !== null) {
      cancelAnimationFrame(renderRafId);
    }
    micCapture.stop();
    audioEngine.destroy();
    youtubePlayer.destroy();
  };
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}