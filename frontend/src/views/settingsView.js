/**
 * Tela de Configurações (#/configuracoes) — FRONTEND_ARCHITECTURE.md §5.3 e T4.6.3:
 * 5 abas organizadas:
 * 1. Áudio e Microfone (dispositivo, teste VU + nota YIN, ganho, gate, latência manual/4 bips e volumes padrão)
 * 2. Jogadores (criar, renomear, selecionar ativo e excluir com opção de manter ou apagar histórico)
 * 3. Gameplay e Dificuldade (dificuldade padrão, contagem regressiva, vídeo, nota parcial, auto-transposição, Convidado/abandono)
 * 4. Idioma e Aparência (tema Escuro/Claro e idioma pt-BR/en-US)
 * 5. Sistema e Diagnóstico (/api/health?refresh=1 e /api/config)
 */

import { api } from "../api.js";
import { createCalibrationSession } from "../audio/latencyCalibrator.js";
import { createMicCapture, listAudioInputDevices } from "../audio/micCapture.js";
import { midiToNoteName } from "../audio/yinDetector.js";
import { DEFAULT_GAME_PREFS, PREFS_STORAGE_KEY, loadGamePrefs } from "../game/session.js";
import { getLocale, setLocale, t } from "../i18n.js";
import { playerStore } from "../players/playerStore.js";
import { renderCurrentRoute } from "../router.js";
import {
  getAudioSettings,
  getState,
  resetAudioSettings,
  setState,
  setTheme,
  showBanner,
  updateAudioSettings,
} from "../store.js";
import { confirmDialog } from "../ui/confirmModal.js";

function rmsToMeterPercent(rms) {
  const clamped = Math.max(0, Math.min(0.4, Number(rms) || 0));
  const scaled = Math.sqrt(clamped / 0.35) * 100;
  return Math.min(100, Math.max(0, scaled));
}

function saveGamePrefsPatch(patch) {
  const current = loadGamePrefs();
  const next = { ...DEFAULT_GAME_PREFS, ...current, ...patch };
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Ignora falha de quota
  }
  return next;
}

export function renderSettingsView(container) {
  let disposed = false;
  let activeTab = "audio"; // "audio" | "players" | "gameplay" | "appearance" | "system"
  let calibrating = false;
  let activeCalibrationSession = null;
  let calibrationBeepTimers = [];

  const settings = getAudioSettings();

  container.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "manage-shell";

  // Cabeçalho com as 5 abas
  const headerCard = document.createElement("section");
  headerCard.className = "card";

  const mainTitle = document.createElement("h1");
  mainTitle.textContent = "Configurações";

  const tabsBar = document.createElement("div");
  tabsBar.className = "tabs-bar";
  tabsBar.setAttribute("role", "tablist");

  const tabDefs = [
    { id: "audio", label: "Áudio e Microfone" },
    { id: "players", label: "Jogadores" },
    { id: "gameplay", label: "Gameplay e Dificuldade" },
    { id: "appearance", label: "Idioma e Aparência" },
    { id: "system", label: "Sistema e Diagnóstico" },
  ];

  const tabButtons = new Map();
  const tabPanels = new Map();

  for (const def of tabDefs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = def.id === activeTab ? "tab-btn active" : "tab-btn";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", def.id === activeTab ? "true" : "false");
    btn.textContent = def.label;
    btn.addEventListener("click", () => switchTab(def.id));
    tabsBar.appendChild(btn);
    tabButtons.set(def.id, btn);
  }

  headerCard.append(mainTitle, tabsBar);
  shell.appendChild(headerCard);

  // =========================================================================
  // ABA 1: ÁUDIO E MICROFONE (calibração e teste ao vivo preservados)
  // =========================================================================
  const audioPanel = document.createElement("div");
  audioPanel.className = "settings-grid";
  tabPanels.set("audio", audioPanel);

  audioPanel.innerHTML = `
    <section class="card">
      <h2>${t("settings.title")}</h2>
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
  `;

  const micSelect = audioPanel.querySelector("#cfg-mic-select");
  const refreshBtn = audioPanel.querySelector("#cfg-mic-refresh");
  const toggleBtn = audioPanel.querySelector("#cfg-mic-toggle");
  const micStatusEl = audioPanel.querySelector("#cfg-mic-status");

  const pitchNoteEl = audioPanel.querySelector("#cfg-pitch-note");
  const pitchHzEl = audioPanel.querySelector("#cfg-pitch-hz");
  const pitchClarityEl = audioPanel.querySelector("#cfg-pitch-clarity");
  const vuFillEl = audioPanel.querySelector("#cfg-vu-fill");
  const vuGateEl = audioPanel.querySelector("#cfg-vu-gate");

  const gainSlider = audioPanel.querySelector("#cfg-gain-slider");
  const gainValEl = audioPanel.querySelector("#cfg-gain-val");
  const gateSlider = audioPanel.querySelector("#cfg-gate-slider");
  const gateValEl = audioPanel.querySelector("#cfg-gate-val");

  const latSlider = audioPanel.querySelector("#cfg-lat-slider");
  const latValEl = audioPanel.querySelector("#cfg-lat-val");
  const latMinusBtn = audioPanel.querySelector("#cfg-lat-minus");
  const latPlusBtn = audioPanel.querySelector("#cfg-lat-plus");

  const autoCalibBtn = audioPanel.querySelector("#cfg-auto-calib-btn");
  const autoCalibStatusEl = audioPanel.querySelector("#cfg-auto-calib-status");

  const defInstSlider = audioPanel.querySelector("#cfg-def-inst");
  const defInstValEl = audioPanel.querySelector("#cfg-def-inst-val");
  const defVocSlider = audioPanel.querySelector("#cfg-def-voc");
  const defVocValEl = audioPanel.querySelector("#cfg-def-voc-val");
  const resetBtn = audioPanel.querySelector("#cfg-reset-btn");

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
      // Ignora restrição antes de permissão
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

  latSlider?.addEventListener("input", () => applyLatencyUi(Number(latSlider.value)));
  latMinusBtn?.addEventListener("click", () => applyLatencyUi(getAudioSettings().micLatencyMs - 10));
  latPlusBtn?.addEventListener("click", () => applyLatencyUi(getAudioSettings().micLatencyMs + 10));

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
        showBanner(
          "success",
          t("settings.autoCalibSuccess", {
            ms: summary.medianMs,
            valid: summary.validCount,
            total: summary.totalBeeps,
          })
        );
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

  // =========================================================================
  // ABA 2: JOGADORES (CRUD + destino do histórico)
  // =========================================================================
  const playersPanel = document.createElement("section");
  playersPanel.className = "card";
  playersPanel.hidden = true;
  tabPanels.set("players", playersPanel);

  const pTitle = document.createElement("h2");
  pTitle.textContent = "Gerenciar Jogadores Locais";
  const pDesc = document.createElement("p");
  pDesc.className = "muted";
  pDesc.textContent =
    "Crie perfis individuais para registrar notas e recordes no histórico, ou use o perfil Convidado.";

  const createForm = document.createElement("form");
  createForm.className = "inline-action-form";
  const newNameInput = document.createElement("input");
  newNameInput.type = "text";
  newNameInput.className = "text-input";
  newNameInput.maxLength = 30;
  newNameInput.placeholder = "Nome do novo jogador (1 a 30 caracteres)...";
  newNameInput.setAttribute("aria-label", "Nome do novo jogador");

  const createBtn = document.createElement("button");
  createBtn.type = "submit";
  createBtn.className = "btn btn-primary";
  createBtn.textContent = "Criar jogador";
  createForm.append(newNameInput, createBtn);

  const playersListHost = document.createElement("div");
  playersListHost.className = "players-manage-list";

  playersPanel.append(pTitle, pDesc, createForm, playersListHost);

  function renderPlayersManageList() {
    playersListHost.replaceChildren();
    const active = playerStore.getActivePlayer();
    const list = playerStore.getPlayers();

    // Linha fixa: Convidado
    const guestRow = document.createElement("div");
    guestRow.className = "player-manage-row";
    const guestInfo = document.createElement("div");
    const guestName = document.createElement("strong");
    guestName.textContent = "Convidado (padrão)";
    const guestSub = document.createElement("div");
    guestSub.className = "muted";
    guestSub.textContent = "Perfil rápido sem cadastro fixo.";
    guestInfo.append(guestName, guestSub);

    const guestSelectBtn = document.createElement("button");
    guestSelectBtn.type = "button";
    guestSelectBtn.className = active.isGuest ? "btn btn-primary" : "btn btn-secondary";
    guestSelectBtn.textContent = active.isGuest ? "Ativo" : "Usar Convidado";
    guestSelectBtn.disabled = active.isGuest;
    guestSelectBtn.addEventListener("click", () => {
      playerStore.selectPlayer("guest");
      renderPlayersManageList();
    });
    guestRow.append(guestInfo, guestSelectBtn);
    playersListHost.appendChild(guestRow);

    for (const player of list) {
      const row = document.createElement("div");
      row.className = "player-manage-row";

      const isCurrent = !active.isGuest && active.id === player.id;

      const info = document.createElement("div");
      const nameEl = document.createElement("strong");
      nameEl.textContent = player.name;
      const metaEl = document.createElement("div");
      metaEl.className = "muted";
      metaEl.textContent = isCurrent ? "Jogador selecionado atualmente" : "Perfil local";
      info.append(nameEl, metaEl);

      const actions = document.createElement("div");
      actions.className = "library-item-actions";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = isCurrent ? "btn btn-primary" : "btn btn-secondary";
      selectBtn.textContent = isCurrent ? "Ativo" : "Selecionar";
      selectBtn.disabled = isCurrent;
      selectBtn.addEventListener("click", () => {
        playerStore.selectPlayer(player.id);
        renderPlayersManageList();
      });

      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "btn btn-secondary";
      renameBtn.textContent = "Renomear";
      renameBtn.addEventListener("click", () => {
        // Transforma a linha em edição inline segura
        info.replaceChildren();
        const editForm = document.createElement("form");
        editForm.className = "inline-action-form";
        const editInput = document.createElement("input");
        editInput.type = "text";
        editInput.className = "text-input";
        editInput.maxLength = 30;
        editInput.value = player.name;
        const saveBtn = document.createElement("button");
        saveBtn.type = "submit";
        saveBtn.className = "btn btn-primary";
        saveBtn.textContent = "Salvar";
        const cancelEditBtn = document.createElement("button");
        cancelEditBtn.type = "button";
        cancelEditBtn.className = "btn btn-secondary";
        cancelEditBtn.textContent = "Cancelar";
        cancelEditBtn.addEventListener("click", () => renderPlayersManageList());

        editForm.append(editInput, saveBtn, cancelEditBtn);
        editForm.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          try {
            await playerStore.renamePlayer(player.id, editInput.value);
            showBanner("success", "Nome do jogador atualizado.");
            renderPlayersManageList();
          } catch (err) {
            showBanner("warning", err.message);
          }
        });
        info.appendChild(editForm);
        editInput.focus();
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-danger";
      deleteBtn.textContent = "Excluir";
      deleteBtn.addEventListener("click", async () => {
        const keepHistory = await confirmDialog({
          title: `Excluir "${player.name}"`,
          message:
            "Deseja MANTER as partidas antigas deste jogador no histórico (como Convidado)? Clique em 'Manter histórico' ou em 'Apagar tudo' para excluir também as partidas.",
          confirmText: "Manter histórico",
          cancelText: "Apagar tudo",
          danger: false,
        });
        if (disposed) return;

        const finalConfirm = await confirmDialog({
          title: "Confirmar exclusão do perfil",
          message: keepHistory
            ? `O perfil "${player.name}" será excluído e suas partidas ficarão preservadas no histórico.`
            : `O perfil "${player.name}" E TODAS as suas partidas no histórico serão apagados permanentemente.`,
          confirmText: "Confirmar exclusão",
          danger: true,
        });
        if (!finalConfirm || disposed) return;

        try {
          await playerStore.deletePlayer(player.id, keepHistory ? "keep" : "delete");
          showBanner("info", `Perfil "${player.name}" removido.`);
          renderPlayersManageList();
        } catch (err) {
          showBanner("error", err.message);
        }
      });

      actions.append(selectBtn, renameBtn, deleteBtn);
      row.append(info, actions);
      playersListHost.appendChild(row);
    }
  }

  createForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const raw = newNameInput.value;
    if (!raw.trim()) return;
    createBtn.disabled = true;
    try {
      await playerStore.createPlayer(raw);
      newNameInput.value = "";
      showBanner("success", "Jogador criado e selecionado!");
      renderPlayersManageList();
    } catch (err) {
      showBanner("warning", err.message);
    } finally {
      createBtn.disabled = false;
    }
  });

  // =========================================================================
  // ABA 3: GAMEPLAY E DIFICULDADE (`karaoke.prefs.v1`)
  // =========================================================================
  const gameplayPanel = document.createElement("section");
  gameplayPanel.className = "card";
  gameplayPanel.hidden = true;
  tabPanels.set("gameplay", gameplayPanel);

  const gpTitle = document.createElement("h2");
  gpTitle.textContent = "Gameplay e Dificuldade";
  const gpDesc = document.createElement("p");
  gpDesc.className = "muted";
  gpDesc.textContent =
    "Defina o comportamento padrão das partidas no Modo Karaokê.";
  gameplayPanel.append(gpTitle, gpDesc);

  const currentPrefs = loadGamePrefs();

  function addPrefRow(labelText, descText, controlEl) {
    const row = document.createElement("div");
    row.className = "settings-row";
    const left = document.createElement("div");
    left.className = "settings-label-group";
    const tEl = document.createElement("span");
    tEl.className = "settings-label-title";
    tEl.textContent = labelText;
    const dEl = document.createElement("span");
    dEl.className = "settings-label-desc";
    dEl.textContent = descText;
    left.append(tEl, dEl);
    row.append(left, controlEl);
    gameplayPanel.appendChild(row);
  }

  // Dificuldade padrão
  const defDiffSel = document.createElement("select");
  defDiffSel.className = "select-control";
  for (const optDef of [
    { value: "easy", label: "Fácil" },
    { value: "normal", label: "Normal" },
    { value: "hard", label: "Difícil" },
  ]) {
    const opt = document.createElement("option");
    opt.value = optDef.value;
    opt.textContent = optDef.label;
    if (optDef.value === currentPrefs.difficulty) opt.selected = true;
    defDiffSel.appendChild(opt);
  }
  defDiffSel.addEventListener("change", () => {
    saveGamePrefsPatch({ difficulty: defDiffSel.value });
    showBanner("info", "Dificuldade padrão atualizada.");
  });
  addPrefRow(
    "Dificuldade padrão",
    "Define a tolerância de semitons e rigor da pontuação.",
    defDiffSel
  );

  // Contagem regressiva
  const countdownSel = document.createElement("select");
  countdownSel.className = "select-control";
  for (const sec of [0, 3, 5]) {
    const opt = document.createElement("option");
    opt.value = String(sec);
    opt.textContent = sec === 0 ? "Sem contagem (0s)" : `${sec} segundos`;
    if (sec === currentPrefs.countdownSeconds) opt.selected = true;
    countdownSel.appendChild(opt);
  }
  countdownSel.addEventListener("change", () => {
    saveGamePrefsPatch({ countdownSeconds: Number(countdownSel.value) });
  });
  addPrefRow(
    "Contagem regressiva",
    "Tempo de preparação antes de iniciar a reprodução no palco.",
    countdownSel
  );

  function createBoolToggle(initialValue, onChange) {
    let val = Boolean(initialValue);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = val ? "btn btn-primary" : "btn btn-secondary";
    btn.textContent = val ? "Ativado" : "Desativado";
    btn.addEventListener("click", () => {
      val = !val;
      btn.className = val ? "btn btn-primary" : "btn btn-secondary";
      btn.textContent = val ? "Ativado" : "Desativado";
      onChange(val);
    });
    return btn;
  }

  addPrefRow(
    "Vídeo do YouTube no palco",
    "Exibe o videoclipe sincronizado ao fundo enquanto canta.",
    createBoolToggle(currentPrefs.showVideo, (v) => saveGamePrefsPatch({ showVideo: v }))
  );

  addPrefRow(
    "Nota parcial em tempo real",
    "Mostra a evolução da pontuação no HUD durante a música.",
    createBoolToggle(currentPrefs.showPartialScore, (v) =>
      saveGamePrefsPatch({ showPartialScore: v })
    )
  );

  addPrefRow(
    "Auto-transposição de oitava",
    "Aceita automaticamente notas cantadas uma oitava acima ou abaixo da referência.",
    createBoolToggle(currentPrefs.autoTranspose, (v) => saveGamePrefsPatch({ autoTranspose: v }))
  );

  addPrefRow(
    "Registrar partidas de Convidado",
    "Salva no histórico mesmo quando nenhum perfil de jogador está selecionado.",
    createBoolToggle(currentPrefs.recordGuest, (v) => saveGamePrefsPatch({ recordGuest: v }))
  );

  addPrefRow(
    "Registrar partidas abandonadas",
    "Salva a pontuação parcial caso você saia antes do fim da música.",
    createBoolToggle(currentPrefs.recordAbandoned, (v) =>
      saveGamePrefsPatch({ recordAbandoned: v })
    )
  );

  // =========================================================================
  // ABA 4: IDIOMA E APARÊNCIA
  // =========================================================================
  const appearancePanel = document.createElement("section");
  appearancePanel.className = "card";
  appearancePanel.hidden = true;
  tabPanels.set("appearance", appearancePanel);

  const appTitle = document.createElement("h2");
  appTitle.textContent = "Idioma e Aparência";
  appearancePanel.appendChild(appTitle);

  const themeRow = document.createElement("div");
  themeRow.className = "settings-row";
  const themeLbl = document.createElement("div");
  themeLbl.className = "settings-label-group";
  const themeT = document.createElement("span");
  themeT.className = "settings-label-title";
  themeT.textContent = "Tema visual";
  const themeD = document.createElement("span");
  themeD.className = "settings-label-desc";
  themeD.textContent = "Escolha entre o modo escuro (ideal para ambiente de karaokê) ou claro.";
  themeLbl.append(themeT, themeD);

  const themeSel = document.createElement("select");
  themeSel.className = "select-control";
  for (const optDef of [
    { value: "dark", label: "Escuro" },
    { value: "light", label: "Claro" },
  ]) {
    const opt = document.createElement("option");
    opt.value = optDef.value;
    opt.textContent = optDef.label;
    if (optDef.value === getState().theme) opt.selected = true;
    themeSel.appendChild(opt);
  }
  themeSel.addEventListener("change", () => {
    setTheme(themeSel.value);
    const headerTheme = document.getElementById("theme-select");
    if (headerTheme) headerTheme.value = themeSel.value;
  });
  themeRow.append(themeLbl, themeSel);

  const langRow = document.createElement("div");
  langRow.className = "settings-row";
  const langLbl = document.createElement("div");
  langLbl.className = "settings-label-group";
  const langT = document.createElement("span");
  langT.className = "settings-label-title";
  langT.textContent = "Idioma da interface";
  const langD = document.createElement("span");
  langD.className = "settings-label-desc";
  langD.textContent = "Altera os textos de menus e controles do aplicativo.";
  langLbl.append(langT, langD);

  const langSel = document.createElement("select");
  langSel.className = "select-control";
  for (const optDef of [
    { value: "pt-BR", label: "Português (Brasil)" },
    { value: "en-US", label: "English (US)" },
  ]) {
    const opt = document.createElement("option");
    opt.value = optDef.value;
    opt.textContent = optDef.label;
    if (optDef.value === getLocale()) opt.selected = true;
    langSel.appendChild(opt);
  }
  langSel.addEventListener("change", async () => {
    const next = await setLocale(langSel.value);
    setState({ locale: next });
    const headerLocale = document.getElementById("locale-select");
    if (headerLocale) headerLocale.value = next;
    renderCurrentRoute();
  });
  langRow.append(langLbl, langSel);

  appearancePanel.append(themeRow, langRow);

  // =========================================================================
  // ABA 5: SISTEMA E DIAGNÓSTICO
  // =========================================================================
  const systemPanel = document.createElement("section");
  systemPanel.className = "card";
  systemPanel.hidden = true;
  tabPanels.set("system", systemPanel);

  const sysHeader = document.createElement("div");
  sysHeader.className = "section-header-row";
  const sysTitle = document.createElement("h2");
  sysTitle.textContent = "Sistema e Diagnóstico";
  const recheckBtn = document.createElement("button");
  recheckBtn.type = "button";
  recheckBtn.className = "btn btn-primary";
  recheckBtn.textContent = "Reverificar dependências";
  sysHeader.append(sysTitle, recheckBtn);

  const sysHost = document.createElement("div");
  sysHost.className = "system-diag-list";

  systemPanel.append(sysHeader, sysHost);

  async function loadSystemDiagnostics(forceRefresh = false) {
    sysHost.replaceChildren();
    const loadingP = document.createElement("p");
    loadingP.className = "muted";
    loadingP.textContent = "Consultando estado do servidor local e worker Python...";
    sysHost.appendChild(loadingP);

    try {
      const [health, cfg] = await Promise.all([
        api.getHealth(forceRefresh),
        api.getConfig().catch(() => getState().config || {}),
      ]);
      if (disposed) return;

      setState({ health, config: cfg });
      sysHost.replaceChildren();

      const worker = health?.worker || {};
      const deps = worker?.dependencies || {};

      const rows = [
        ["Status geral", health?.status === "ok" ? "Pronto (OK)" : "Degradado / Atenção"],
        [
          "Acelerador detectado",
          String(worker.accelerator_detected || "cpu").toUpperCase(),
        ],
        ["Dispositivo ativo", String(worker.device || "cpu").toUpperCase()],
        ["Python", worker.python_version || "Não detectado"],
        ["FFmpeg", deps.ffmpeg ? "Disponível" : "Ausente"],
        ["yt-dlp", deps.yt_dlp ? "Disponível" : "Ausente"],
        ["Demucs", deps.demucs ? "Disponível" : "Ausente"],
        ["PyTorch", deps.torch ? "Disponível" : "Ausente"],
        ["Diretório de cache", cfg?.cacheDir || "./cache"],
        ["Diretório de dados", cfg?.dataDir || "./data"],
      ];

      for (const [kText, vText] of rows) {
        const row = document.createElement("div");
        row.className = "history-detail-row";
        const k = document.createElement("span");
        k.className = "muted";
        k.textContent = kText;
        const v = document.createElement("strong");
        v.className = "mono";
        v.textContent = String(vText);
        row.append(k, v);
        sysHost.appendChild(row);
      }
    } catch (err) {
      if (!disposed) {
        sysHost.replaceChildren();
        const errP = document.createElement("p");
        errP.className = "muted";
        errP.textContent = `Falha ao consultar diagnóstico: ${err.message}`;
        sysHost.appendChild(errP);
      }
    }
  }

  recheckBtn.addEventListener("click", async () => {
    recheckBtn.disabled = true;
    await loadSystemDiagnostics(true);
    recheckBtn.disabled = false;
  });

  function switchTab(nextTab) {
    activeTab = nextTab;
    for (const [id, btn] of tabButtons.entries()) {
      const isAct = id === activeTab;
      btn.classList.toggle("active", isAct);
      btn.setAttribute("aria-selected", isAct ? "true" : "false");
    }
    for (const [id, panel] of tabPanels.entries()) {
      panel.hidden = id !== activeTab;
    }

    if (activeTab === "players") {
      playerStore.loadPlayers().finally(() => {
        if (!disposed) renderPlayersManageList();
      });
    } else if (activeTab === "system") {
      loadSystemDiagnostics(false);
    }
  }

  shell.append(audioPanel, playersPanel, gameplayPanel, appearancePanel, systemPanel);
  container.appendChild(shell);

  populateDevices();

  return () => {
    disposed = true;
    calibrating = false;
    clearCalibrationTimers();
    micCapture.stop();
  };
}