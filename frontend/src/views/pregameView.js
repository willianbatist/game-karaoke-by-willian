/**
 * Tela Pré-Jogo (#/pre-jogo/:videoId) — FRONTEND_ARCHITECTURE.md §5.3 e T4.5.4:
 * - Selo de compatibilidade definitivo (Fase 2) com motivos em linguagem simples
 * - Ações: "Cantar!" (interação do usuário para autoplay), "Escolher outra versão" e "Trocar letra" (modal LRCLIB)
 * - Confirmação rápida do jogador ativo
 * - Ajustes rápidos: dificuldade, volume da voz guia, exibir vídeo e offset de latência da música
 */

import { api } from "../api.js";
import { DEFAULT_GAME_PREFS, PREFS_STORAGE_KEY, loadGamePrefs } from "../game/session.js";
import { playerStore } from "../players/playerStore.js";
import { navigate } from "../router.js";
import { getAudioSettings, getState, showBanner, updateAudioSettings } from "../store.js";
import { createCompatibilityBadge } from "../ui/components/compatibilityBadge.js";

function formatDuration(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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

export function renderPregameView(container, params) {
  const { videoId } = params;
  let disposed = false;
  let manifestData = null;
  let lyricsData = null;

  const prefs = loadGamePrefs();
  const audioSettings = getAudioSettings();
  const devicePairKey = `${audioSettings.micDeviceId || "default"}|default`;

  let selectedDifficulty = prefs.difficulty;
  let selectedGuideVol = audioSettings.defaultVocalsVol;
  let selectedShowVideo = prefs.showVideo;
  let selectedLatencyMs = Number(audioSettings.micLatencyMs) || 0;

  container.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "pregame-shell";

  const mainCard = document.createElement("section");
  mainCard.className = "card";

  // Cabeçalho da música
  const topRow = document.createElement("div");
  topRow.className = "section-header-row";

  const titleWrap = document.createElement("div");
  const kicker = document.createElement("span");
  kicker.className = "result-kicker";
  kicker.textContent = "Resumo Pré-Jogo";

  const titleEl = document.createElement("h1");
  titleEl.textContent = `Carregando ${videoId}...`;

  const subtitleEl = document.createElement("p");
  subtitleEl.className = "muted";
  subtitleEl.textContent = "Buscando análise da faixa no cache local...";

  titleWrap.append(kicker, titleEl, subtitleEl);

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn-secondary";
  backBtn.textContent = "← Voltar";
  backBtn.addEventListener("click", () => navigate("/"));

  topRow.append(titleWrap, backBtn);

  // Selo de compatibilidade definitivo (Fase 2)
  const compatHost = document.createElement("div");
  compatHost.className = "pregame-compat-host";

  // Confirmação de jogador
  const playerRow = document.createElement("div");
  playerRow.className = "pregame-row";

  const playerLabelGroup = document.createElement("div");
  const playerTitle = document.createElement("strong");
  playerTitle.textContent = "Jogador da partida";
  const playerDesc = document.createElement("div");
  playerDesc.className = "muted";
  playerDesc.textContent = "A nota final será salva no histórico deste perfil.";
  playerLabelGroup.append(playerTitle, playerDesc);

  const playerSelect = document.createElement("select");
  playerSelect.className = "select-control";
  playerSelect.setAttribute("aria-label", "Selecionar jogador");

  function populatePlayerSelect() {
    const active = playerStore.getActivePlayer();
    const list = playerStore.getPlayers();
    playerSelect.replaceChildren();

    const guestOpt = document.createElement("option");
    guestOpt.value = "guest";
    guestOpt.textContent = "Convidado";
    if (active.isGuest) guestOpt.selected = true;
    playerSelect.appendChild(guestOpt);

    for (const p of list) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      if (!active.isGuest && active.id === p.id) opt.selected = true;
      playerSelect.appendChild(opt);
    }
  }

  playerSelect.addEventListener("change", () => {
    playerStore.selectPlayer(playerSelect.value);
  });

  populatePlayerSelect();
  playerRow.append(playerLabelGroup, playerSelect);

  // Letra selecionada + botão Trocar Letra
  const lyricsRow = document.createElement("div");
  lyricsRow.className = "pregame-row";

  const lyricsLabelGroup = document.createElement("div");
  const lyricsTitle = document.createElement("strong");
  lyricsTitle.textContent = "Letra sincronizada";
  const lyricsStatusEl = document.createElement("div");
  lyricsStatusEl.className = "muted";
  lyricsStatusEl.textContent = "Verificando candidatos de letra...";
  lyricsLabelGroup.append(lyricsTitle, lyricsStatusEl);

  const changeLyricsBtn = document.createElement("button");
  changeLyricsBtn.type = "button";
  changeLyricsBtn.className = "btn btn-secondary";
  changeLyricsBtn.textContent = "Trocar letra";
  changeLyricsBtn.disabled = true;

  lyricsRow.append(lyricsLabelGroup, changeLyricsBtn);

  // Ajustes rápidos
  const adjustmentsCard = document.createElement("section");
  adjustmentsCard.className = "card";

  const adjHeading = document.createElement("h2");
  adjHeading.textContent = "Ajustes rápidos";

  // 1. Dificuldade
  const diffRow = document.createElement("div");
  diffRow.className = "pregame-row";
  const diffLabel = document.createElement("strong");
  diffLabel.textContent = "Dificuldade";

  const diffSelect = document.createElement("select");
  diffSelect.className = "select-control";
  diffSelect.setAttribute("aria-label", "Dificuldade");
  for (const optDef of [
    { value: "easy", label: "Fácil (tolerância ampla)" },
    { value: "normal", label: "Normal (padrão)" },
    { value: "hard", label: "Difícil (afinação rigorosa)" },
  ]) {
    const opt = document.createElement("option");
    opt.value = optDef.value;
    opt.textContent = optDef.label;
    if (optDef.value === selectedDifficulty) opt.selected = true;
    diffSelect.appendChild(opt);
  }
  diffSelect.addEventListener("change", () => {
    selectedDifficulty = diffSelect.value;
    saveGamePrefsPatch({ difficulty: selectedDifficulty });
  });
  diffRow.append(diffLabel, diffSelect);

  // 2. Volume da voz guia
  const guideRow = document.createElement("div");
  guideRow.className = "pregame-row";
  const guideLabel = document.createElement("strong");
  guideLabel.textContent = "Volume da voz guia";

  const guideControls = document.createElement("div");
  guideControls.className = "pregame-inline-controls";
  const guideSlider = document.createElement("input");
  guideSlider.type = "range";
  guideSlider.min = "0";
  guideSlider.max = "1";
  guideSlider.step = "0.05";
  guideSlider.value = String(selectedGuideVol);
  guideSlider.setAttribute("aria-label", "Volume da voz guia");

  const guideVal = document.createElement("span");
  guideVal.className = "mono";
  guideVal.textContent = `${Math.round(selectedGuideVol * 100)}%`;

  guideSlider.addEventListener("input", () => {
    selectedGuideVol = Number(guideSlider.value);
    guideVal.textContent = `${Math.round(selectedGuideVol * 100)}%`;
    updateAudioSettings({ defaultVocalsVol: selectedGuideVol });
  });
  guideControls.append(guideSlider, guideVal);
  guideRow.append(guideLabel, guideControls);

  // 3. Exibir vídeo de fundo
  const videoRow = document.createElement("div");
  videoRow.className = "pregame-row";
  const videoLabel = document.createElement("strong");
  videoLabel.textContent = "Vídeo do YouTube no palco";

  const videoToggleBtn = document.createElement("button");
  videoToggleBtn.type = "button";
  videoToggleBtn.className = "btn btn-secondary";
  videoToggleBtn.textContent = selectedShowVideo ? "Ativado" : "Desativado";
  videoToggleBtn.addEventListener("click", () => {
    selectedShowVideo = !selectedShowVideo;
    videoToggleBtn.textContent = selectedShowVideo ? "Ativado" : "Desativado";
    saveGamePrefsPatch({ showVideo: selectedShowVideo });
  });
  videoRow.append(videoLabel, videoToggleBtn);

  // 4. Offset de latência da música
  const latencyRow = document.createElement("div");
  latencyRow.className = "pregame-row";
  const latencyLabel = document.createElement("strong");
  latencyLabel.textContent = "Latência do microfone (esta música)";

  const latencyControls = document.createElement("div");
  latencyControls.className = "pregame-inline-controls";
  const latMinus = document.createElement("button");
  latMinus.type = "button";
  latMinus.className = "btn btn-secondary";
  latMinus.textContent = "-10ms";

  const latVal = document.createElement("span");
  latVal.className = "mono";
  latVal.textContent = `${selectedLatencyMs} ms`;

  const latPlus = document.createElement("button");
  latPlus.type = "button";
  latPlus.className = "btn btn-secondary";
  latPlus.textContent = "+10ms";

  async function applySongLatency(nextMs) {
    selectedLatencyMs = Math.max(-300, Math.min(500, Math.round(nextMs)));
    latVal.textContent = `${selectedLatencyMs} ms`;
    updateAudioSettings({ micLatencyMs: selectedLatencyMs });
    try {
      await api.patchSong(videoId, {
        user: { latency_offsets_ms: { [devicePairKey]: selectedLatencyMs } },
      });
    } catch {
      // Ignora erro de rede; ajuste fica ativo localmente
    }
  }

  latMinus.addEventListener("click", () => applySongLatency(selectedLatencyMs - 10));
  latPlus.addEventListener("click", () => applySongLatency(selectedLatencyMs + 10));

  latencyControls.append(latMinus, latVal, latPlus);
  latencyRow.append(latencyLabel, latencyControls);

  adjustmentsCard.append(adjHeading, diffRow, guideRow, videoRow, latencyRow);

  // Barra de ações principais (Cantar! / Escolher outra versão)
  const ctaBar = document.createElement("div");
  ctaBar.className = "pregame-cta-bar";

  const otherVersionBtn = document.createElement("button");
  otherVersionBtn.type = "button";
  otherVersionBtn.className = "btn btn-secondary";
  otherVersionBtn.textContent = "Escolher outra versão";
  otherVersionBtn.addEventListener("click", () => {
    const q = getState().lastSearchQuery || manifestData?.source?.title || "";
    if (q) {
      navigate(`/busca?q=${encodeURIComponent(q)}`);
    } else {
      navigate("/");
    }
  });

  const singNowBtn = document.createElement("button");
  singNowBtn.type = "button";
  singNowBtn.className = "btn btn-primary btn-cta-large";
  singNowBtn.textContent = "Cantar!";
  singNowBtn.disabled = true;
  singNowBtn.addEventListener("click", () => {
    navigate(`/jogo/${encodeURIComponent(videoId)}`);
  });

  ctaBar.append(otherVersionBtn, singNowBtn);

  // Modal de troca de letra (LRCLIB candidates)
  const lyricsModalBackdrop = document.createElement("div");
  lyricsModalBackdrop.className = "modal-backdrop";
  lyricsModalBackdrop.hidden = true;
  lyricsModalBackdrop.setAttribute("role", "dialog");
  lyricsModalBackdrop.setAttribute("aria-modal", "true");
  lyricsModalBackdrop.setAttribute("aria-label", "Escolher versão da letra");

  const lyricsModalDialog = document.createElement("div");
  lyricsModalDialog.className = "modal-dialog lyrics-modal-dialog";

  const modalTitle = document.createElement("h3");
  modalTitle.className = "modal-title";
  modalTitle.textContent = "Escolher versão da letra";

  const modalList = document.createElement("div");
  modalList.className = "lyrics-candidates-list";

  const modalCloseBtn = document.createElement("button");
  modalCloseBtn.type = "button";
  modalCloseBtn.className = "btn btn-secondary";
  modalCloseBtn.textContent = "Fechar";
  modalCloseBtn.addEventListener("click", () => {
    lyricsModalBackdrop.hidden = true;
  });

  lyricsModalDialog.append(modalTitle, modalList, modalCloseBtn);
  lyricsModalBackdrop.appendChild(lyricsModalDialog);

  function renderLyricsSummary() {
    const lyrMeta = manifestData?.lyrics || {};
    const candidates = Array.isArray(lyricsData?.candidates) ? lyricsData.candidates : [];

    if (candidates.length === 0) {
      lyricsStatusEl.textContent = "Nenhuma letra encontrada no LRCLIB (modo instrumental).";
      changeLyricsBtn.disabled = true;
      return;
    }

    changeLyricsBtn.disabled = false;
    const activeCandidate = candidates.find((c) => c.id === lyrMeta.selected_id) || candidates[0];
    const kind = activeCandidate?.syncedLyrics ? "Sincronizada (.lrc)" : "Texto sem tempo";
    lyricsStatusEl.textContent = `${kind}: ${activeCandidate.artistName || ""} — ${activeCandidate.trackName || ""} (${candidates.length} opção(ões))`;
  }

  function openLyricsModal() {
    const candidates = Array.isArray(lyricsData?.candidates) ? lyricsData.candidates : [];
    const activeId = manifestData?.lyrics?.selected_id ?? lyricsData?.selected_id ?? null;
    modalList.replaceChildren();

    for (const cand of candidates) {
      const itemBtn = document.createElement("button");
      itemBtn.type = "button";
      itemBtn.className =
        cand.id === activeId ? "lyrics-candidate-item active" : "lyrics-candidate-item";

      const top = document.createElement("div");
      top.className = "lyrics-candidate-top";

      const name = document.createElement("strong");
      name.textContent = `${cand.artistName || "Artista"} — ${cand.trackName || "Faixa"}`;

      const badge = document.createElement("span");
      badge.className = cand.syncedLyrics ? "pill synced" : "pill";
      badge.textContent = cand.syncedLyrics
        ? `LRC • ${formatDuration(cand.duration)}`
        : `TXT • ${formatDuration(cand.duration)}`;

      top.append(name, badge);

      const preview = document.createElement("div");
      preview.className = "muted lyrics-candidate-preview";
      const sampleText = (cand.plainLyrics || cand.syncedLyrics || "")
        .replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, "")
        .trim()
        .slice(0, 110);
      preview.textContent = sampleText || "Sem prévia de texto";

      itemBtn.append(top, preview);
      itemBtn.addEventListener("click", async () => {
        try {
          const updatedManifest = await api.patchSong(videoId, {
            lyrics: { selected_id: cand.id },
          });
          if (disposed) return;
          manifestData = updatedManifest;
          lyricsModalBackdrop.hidden = true;
          updateCompatibilityDisplay();
          renderLyricsSummary();
          showBanner("success", "Versão da letra atualizada e compatibilidade recalculada!");
        } catch (err) {
          showBanner("error", err.message);
        }
      });

      modalList.appendChild(itemBtn);
    }

    lyricsModalBackdrop.hidden = false;
  }

  changeLyricsBtn.addEventListener("click", openLyricsModal);

  function updateCompatibilityDisplay() {
    const compat = manifestData?.compatibility || {
      level: "regular",
      reasons: [],
      provisional: false,
    };
    compatHost.replaceChildren(
      createCompatibilityBadge(compat, { compact: false, showReasons: true })
    );

    const isLowOrIncompatible =
      compat.level === "low" || compat.level === "incompatible";
    singNowBtn.textContent = isLowOrIncompatible ? "Jogar assim mesmo" : "Cantar!";
  }

  mainCard.append(topRow, compatHost, playerRow, lyricsRow);
  shell.append(mainCard, adjustmentsCard, ctaBar, lyricsModalBackdrop);
  container.appendChild(shell);

  async function loadSongDetails() {
    try {
      const data = await api.getSong(videoId);
      if (disposed) return;

      manifestData = data.manifest;
      lyricsData = data.lyrics;

      if (manifestData.status !== "ready") {
        navigate(`/preparo/${encodeURIComponent(videoId)}`);
        return;
      }

      titleEl.textContent = manifestData.source?.title || videoId;
      const ch = manifestData.source?.channel || "";
      const dur = formatDuration(manifestData.source?.duration);
      subtitleEl.textContent = ch ? `${ch} • Duração: ${dur}` : `Duração: ${dur}`;

      const songLatOffsets = manifestData.user?.latency_offsets_ms || {};
      if (Number.isFinite(Number(songLatOffsets[devicePairKey]))) {
        selectedLatencyMs = Number(songLatOffsets[devicePairKey]);
        latVal.textContent = `${selectedLatencyMs} ms`;
      }

      updateCompatibilityDisplay();
      renderLyricsSummary();
      singNowBtn.disabled = false;
    } catch (err) {
      if (!disposed) {
        if (err.status === 404) {
          navigate(`/preparo/${encodeURIComponent(videoId)}`);
          return;
        }
        subtitleEl.textContent = err.message;
        showBanner("error", err.message);
      }
    }
  }

  loadSongDetails();

  return () => {
    disposed = true;
  };
}