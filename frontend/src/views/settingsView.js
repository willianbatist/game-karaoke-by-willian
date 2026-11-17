/**
 * Tela de Configurações (#/settings):
 * - Seleção de microfone e teste ao vivo com medidor VU + nota YIN
 * - Ganho de entrada e gate de ruído (rmsThreshold)
 * - Calibração de latência (manual + assistente acústico de 4 bips)
 * - Volumes padrão do palco
 */

import { createCalibrationSession } from "../audio/latencyCalibrator.js";
import { createMicCapture, listAudioInputDevices } from "../audio/micCapture.js";
import { midiToNoteName } from "../audio/yinDetector.js";
import { t } from "../i18n.js";
import {
  getAudioSettings,
  resetAudioSettings,
  showBanner,
  updateAudioSettings,
} from "../store.js";
import { confirmDialog } from "../ui/confirmModal.js";

function rmsToMeterPercent(rms) {
  // Escala logarítmica suave para visualização clara entre 0.001 e 0.35
  const clamped = Math.max(0, Math.min(0.4, Number(rms) || 0));
  const scaled = Math.sqrt(clamped / 0.35) * 100;
  return Math.min(100, Math.max(0, scaled));
}

export function renderSettingsView(container) {
  let disposed = false;
  let calibrating = false;
  let activeCalibrationSession = null;
  let calibrationBeepTimers = [];

  const settings = getAudioSettings();

  container.innerHTML = `
    <div class="settings-grid">
      <section class="card">
        <h1>${t("settings.title")}</h1>
        <p class="muted">${t("settings.subtitle")}</p>

        <div class="settings-row">
          <div class="settings-label-group">
            <span class="settings-label-title">${t("settings.micDeviceLabel")}</span>
            <span class="settings-label-desc">${t("settings.micDeviceDesc")}</span>
          </div>
          <div class="settings-control-group">
            <select id="cfg-mic-select" class="select-control" style="max-width: 300px;">
              <option value="">${t("settings.micDefaultOption")}</option>
            </select>
            <button type="button" id="cfg-mic-refresh" class="btn btn-secondary">
              ${t("settings.refreshDevicesBtn")}
            </button>
            <button type="button" id="cfg-mic-toggle" class="btn btn-primary">
              ${t("settings.startMicTestBtn")}
            </button>
          </div>
        </div>

        <div class="vu-panel">
          <div class="vu-header">
            <span class="muted" id="cfg-mic-status">${t("settings.micIdleStatus")}</span>
            <div class="pitch-readout">
              <span id="cfg-pitch-note" class="pitch-note-badge">--</span>
              <span id="cfg-pitch-hz">0.0 Hz</span>
              <span id="cfg-pitch-clarity" class="muted">0%</span>
            </div>
          </div>
          <div class="vu-meter-track">
            <div id="cfg-vu-fill" class="vu-meter-fill"></div>
            <div id="cfg-vu-gate" class="vu-gate-marker" title="Gate"></div>
          </div>
        </div>

        <div class="settings-row">
          <div class="settings-label-group">
            <span class="settings-label-title">${t("settings.inputGainLabel")}</span>
            <span class="settings-label-desc">${t("settings.inputGainDesc")}</span>
          </div>
          <div class="settings-control-group">
            <input type="range" id="cfg-gain-slider" min="0.5" max="3.0" step="0.1" value="${settings.inputGain}" />
            <span id="cfg-gain-val" class="mono">${Math.round(settings.inputGain * 100)}%</span>
          </div>
        </div>

        <div class="settings-row">
          <div class="settings-label-group">
            <span class="settings-label-title">${t("settings.noiseGateLabel")}</span>
            <span class="settings-label-desc">${t("settings.noiseGateDesc")}</span>
          </div>
          <div class="settings-control-group">
            <input type="range" id="cfg-gate-slider" min="0.002" max="0.08" step="0.002" value="${settings.rmsThreshold}" />
            <span id="cfg-gate-val" class="mono">${settings.rmsThreshold.toFixed(3)}</span>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>${t("settings.latencyHeading")}</h2>
        <p class="muted">${t("settings.latencyDesc")}</p>

        <div class="settings-row">
          <div class="settings-label-group">
            <span class="settings-label-title">${t("settings.latencyManualLabel")}</span>
            <span class="settings-label-desc">${t("settings.latencyManualDesc")}</span>
          </div>
          <div class="settings-control-group">
            <button type="button" id="cfg-lat-minus" class="btn btn-secondary">-10 ms</button>
            <input type="range" id="cfg-lat-slider" min="-300" max="500" step="5" value="${settings.micLatencyMs}" />
            <button type="button" id="cfg-lat-plus" class="btn btn-secondary">+10 ms</button>
            <span id="cfg-lat-val" class="mono" style="min-width: 68px; text-align: right;">${settings.micLatencyMs} ms</span>
          </div>
        </div>

        <div class="calibration-box">
          <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem;">
            <div>
              <strong>${t("settings.autoCalibTitle")}</strong>
              <div class="settings-label-desc">${t("settings.autoCalibDesc")}</div>
            </div>
            <button type="button" id="cfg-auto-calib-btn" class="btn btn-primary">
              ${t("settings.autoCalibBtn")}
            </button>
          </div>
          <div id="cfg-auto-calib-status" class="mono muted" style="font-size: 0.88rem;"></div>
        </div>
      </section>

      <section class="card">
        <h2>${t("settings.stageDefaultsHeading")}</h2>

        <div class="settings-row">
          <div class="settings-label-group">
            <span class="settings-label-title">${t("settings.defaultInstLabel")}</span>
          </div>
          <div class="settings-control-group">
            <input type="range" id="cfg-def-inst" min="0" max="1" step="0.05" value="${settings.defaultInstrumentalVol}" />
            <span id="cfg-def-inst-val" class="mono">${Math.round(settings.defaultInstrumentalVol * 100)}%</span>
          </div>
        </div>

        <div class="settings-row">
          <div class="settings-label-group">
            <span class="settings-label-title">${t("settings.defaultVocalsLabel")}</span>
          </div>
          <div class="settings-control-group">
            <input type="range" id="cfg-def-voc" min="0" max="1" step="0.05" value="${settings.defaultVocalsVol}" />
            <span id="cfg-def-voc-val" class="mono">${Math.round(settings.defaultVocalsVol * 100)}%</span>
          </div>
        </div>

        <div style="display: flex; justify-content: flex-end; margin-top: 1.25rem;">
          <button type="button" id="cfg-reset-btn" class="btn btn-secondary">
            ${t("settings.resetDefaultsBtn")}
          </button>
        </div>
      </section>
    </div>
  `;

  const micSelect = container.querySelector("#cfg-mic-select");
  const refreshBtn = container.querySelector("#cfg-mic-refresh");
  const toggleBtn = container.querySelector("#cfg-mic-toggle");
  const micStatusEl = container.querySelector("#cfg-mic-status");

  const pitchNoteEl = container.querySelector("#cfg-pitch-note");
  const pitchHzEl = container.querySelector("#cfg-pitch-hz");
  const pitchClarityEl = container.querySelector("#cfg-pitch-clarity");
  const vuFillEl = container.querySelector("#cfg-vu-fill");
  const vuGateEl = container.querySelector("#cfg-vu-gate");

  const gainSlider = container.querySelector("#cfg-gain-slider");
  const gainValEl = container.querySelector("#cfg-gain-val");
  const gateSlider = container.querySelector("#cfg-gate-slider");
  const gateValEl = container.querySelector("#cfg-gate-val");

  const latSlider = container.querySelector("#cfg-lat-slider");
  const latValEl = container.querySelector("#cfg-lat-val");
  const latMinusBtn = container.querySelector("#cfg-lat-minus");
  const latPlusBtn = container.querySelector("#cfg-lat-plus");

  const autoCalibBtn = container.querySelector("#cfg-auto-calib-btn");
  const autoCalibStatusEl = container.querySelector("#cfg-auto-calib-status");

  const defInstSlider = container.querySelector("#cfg-def-inst");
  const defInstValEl = container.querySelector("#cfg-def-inst-val");
  const defVocSlider = container.querySelector("#cfg-def-voc");
  const defVocValEl = container.querySelector("#cfg-def-voc-val");
  const resetBtn = container.querySelector("#cfg-reset-btn");

  function updateGateMarker(threshold) {
    if (!vuGateEl) return;
    vuGateEl.style.left = `${rmsToMeterPercent(threshold)}%`;
  }

  function applyLatencyUi(ms) {
    const clamped = Math.max(-300, Math.min(500, Math.round(Number(ms) || 0)));
    const updated = updateAudioSettings({ micLatencyMs: clamped });
    latSlider.value = String(updated.micLatencyMs);
    latValEl.textContent = `${updated.micLatencyMs} ms`;
  }

  updateGateMarker(settings.rmsThreshold);

  const micCapture = createMicCapture({
    inputGain: settings.inputGain,
    rmsThreshold: settings.rmsThreshold,
    onStateChange: (isActive) => {
      if (disposed) return;
      toggleBtn.textContent = isActive
        ? t("settings.stopMicTestBtn")
        : t("settings.startMicTestBtn");
      toggleBtn.className = isActive ? "btn btn-danger" : "btn btn-primary";
      micStatusEl.textContent = isActive
        ? t("settings.micActiveStatus")
        : t("settings.micIdleStatus");

      if (!isActive) {
        vuFillEl.style.width = "0%";
        pitchNoteEl.textContent = "--";
        pitchHzEl.textContent = "0.0 Hz";
        pitchClarityEl.textContent = "0%";
      }
    },
    onPitch: (frame) => {
      if (disposed) return;

      if (calibrating && activeCalibrationSession) {
        activeCalibrationSession.processFrame({
          rms: frame.rms,
          timestampMs: performance.now(),
        });
      }

      vuFillEl.style.width = `${rmsToMeterPercent(frame.rms)}%`;

      if (frame.voiced && frame.midi !== null) {
        pitchNoteEl.textContent = midiToNoteName(frame.midi);
        pitchHzEl.textContent = `${frame.freq.toFixed(1)} Hz`;
        pitchClarityEl.textContent = `${Math.round(frame.clarity * 100)}%`;
      } else {
        pitchNoteEl.textContent = "--";
        pitchHzEl.textContent = "0.0 Hz";
        pitchClarityEl.textContent = "0%";
      }
    },
  });

  async function populateDevices() {
    try {
      const devices = await listAudioInputDevices();
      if (disposed) return;
      const savedId = getAudioSettings().micDeviceId;

      micSelect.innerHTML = `<option value="">${t("settings.micDefaultOption")}</option>`;
      for (const dev of devices) {
        if (!dev.deviceId || dev.deviceId === "default") continue;
        const opt = document.createElement("option");
        opt.value = dev.deviceId;
        opt.textContent = dev.label;
        if (dev.deviceId === savedId) {
          opt.selected = true;
        }
        micSelect.appendChild(opt);
      }
    } catch {
      // Ignora caso o navegador restrinja enumerateDevices antes de permissão
    }
  }

  async function ensureMicStarted() {
    if (micCapture.isActive()) return true;
    try {
      const chosenId = micSelect.value || getAudioSettings().micDeviceId || undefined;
      await micCapture.start({ deviceId: chosenId });
      await populateDevices();
      return true;
    } catch (err) {
      showBanner("error", err.message);
      return false;
    }
  }

  refreshBtn?.addEventListener("click", () => populateDevices());

  micSelect?.addEventListener("change", async () => {
    const nextId = micSelect.value;
    updateAudioSettings({ micDeviceId: nextId });
    if (micCapture.isActive()) {
      await micCapture.start({ deviceId: nextId || undefined });
    }
  });

  toggleBtn?.addEventListener("click", async () => {
    if (micCapture.isActive()) {
      await micCapture.stop();
    } else {
      await ensureMicStarted();
    }
  });

  gainSlider?.addEventListener("input", () => {
    const val = Number(gainSlider.value);
    gainValEl.textContent = `${Math.round(val * 100)}%`;
    micCapture.setInputGain(val);
    updateAudioSettings({ inputGain: val });
  });

  gateSlider?.addEventListener("input", () => {
    const val = Number(gateSlider.value);
    gateValEl.textContent = val.toFixed(3);
    updateGateMarker(val);
    micCapture.setRmsThreshold(val);
    updateAudioSettings({ rmsThreshold: val });
  });

  latSlider?.addEventListener("input", () => {
    applyLatencyUi(Number(latSlider.value));
  });

  latMinusBtn?.addEventListener("click", () => {
    applyLatencyUi(getAudioSettings().micLatencyMs - 10);
  });

  latPlusBtn?.addEventListener("click", () => {
    applyLatencyUi(getAudioSettings().micLatencyMs + 10);
  });

  function clearCalibrationTimers() {
    for (const id of calibrationBeepTimers) {
      clearTimeout(id);
    }
    calibrationBeepTimers = [];
  }

  autoCalibBtn?.addEventListener("click", async () => {
    if (calibrating) return;

    const micOk = await ensureMicStarted();
    if (!micOk || disposed) return;

    calibrating = true;
    autoCalibBtn.disabled = true;
    activeCalibrationSession = createCalibrationSession();

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const toneCtx = new AudioCtx();
    if (toneCtx.state === "suspended") {
      await toneCtx.resume();
    }

    const totalBeeps = 4;
    const intervalMs = 700;

    function playCalibrationBeep(beepIndex) {
      if (disposed || !calibrating) return;
      autoCalibStatusEl.textContent = t("settings.autoCalibProgress", {
        current: beepIndex + 1,
        total: totalBeeps,
      });

      const osc = toneCtx.createOscillator();
      const gain = toneCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = 1000;

      const now = toneCtx.currentTime;
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.35, now + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);

      osc.connect(gain);
      gain.connect(toneCtx.destination);

      activeCalibrationSession.registerBeep(performance.now());
      osc.start(now);
      osc.stop(now + 0.05);
    }

    for (let i = 0; i < totalBeeps; i++) {
      const timerId = setTimeout(() => playCalibrationBeep(i), 350 + i * intervalMs);
      calibrationBeepTimers.push(timerId);
    }

    const finishTimer = setTimeout(async () => {
      calibrating = false;
      autoCalibBtn.disabled = false;
      try {
        await toneCtx.close();
      } catch {
        // Ignora
      }

      if (disposed || !activeCalibrationSession) return;
      const summary = activeCalibrationSession.getSummary();
      activeCalibrationSession = null;

      if (summary.medianMs !== null) {
        applyLatencyUi(summary.medianMs);
        autoCalibStatusEl.textContent = t("settings.autoCalibSuccess", {
          ms: summary.medianMs,
          valid: summary.validCount,
          total: summary.totalBeeps,
        });
        showBanner("success", t("settings.autoCalibSuccess", {
          ms: summary.medianMs,
          valid: summary.validCount,
          total: summary.totalBeeps,
        }));
      } else {
        autoCalibStatusEl.textContent = t("settings.autoCalibNoPeak");
        showBanner("warning", t("settings.autoCalibNoPeak"));
      }
    }, 350 + totalBeeps * intervalMs + 300);

    calibrationBeepTimers.push(finishTimer);
  });

  defInstSlider?.addEventListener("input", () => {
    const val = Number(defInstSlider.value);
    defInstValEl.textContent = `${Math.round(val * 100)}%`;
    updateAudioSettings({ defaultInstrumentalVol: val });
  });

  defVocSlider?.addEventListener("input", () => {
    const val = Number(defVocSlider.value);
    defVocValEl.textContent = `${Math.round(val * 100)}%`;
    updateAudioSettings({ defaultVocalsVol: val });
  });

  resetBtn?.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: t("settings.resetConfirmTitle"),
      message: t("settings.resetConfirmMsg"),
      danger: true,
    });
    if (!ok || disposed) return;

    const fresh = resetAudioSettings();
    micSelect.value = fresh.micDeviceId;
    gainSlider.value = String(fresh.inputGain);
    gainValEl.textContent = `${Math.round(fresh.inputGain * 100)}%`;
    micCapture.setInputGain(fresh.inputGain);

    gateSlider.value = String(fresh.rmsThreshold);
    gateValEl.textContent = fresh.rmsThreshold.toFixed(3);
    updateGateMarker(fresh.rmsThreshold);
    micCapture.setRmsThreshold(fresh.rmsThreshold);

    applyLatencyUi(fresh.micLatencyMs);

    defInstSlider.value = String(fresh.defaultInstrumentalVol);
    defInstValEl.textContent = `${Math.round(fresh.defaultInstrumentalVol * 100)}%`;
    defVocSlider.value = String(fresh.defaultVocalsVol);
    defVocValEl.textContent = `${Math.round(fresh.defaultVocalsVol * 100)}%`;

    showBanner("info", t("settings.resetDone"));
  });

  populateDevices();

  return () => {
    disposed = true;
    calibrating = false;
    clearCalibrationTimers();
    micCapture.stop();
  };
}