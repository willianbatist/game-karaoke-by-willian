/**
 * Tela de Resultado (#/result/:sessionId) — T3.4 + T4.4 + Detalhamento Híbrido:
 * - Exibe nota final (0.0 a 10.0) com classificação motivacional via standardMode.summary()
 * - Exibe o detalhamento híbrido: Afinação (Melodia) vs. Sincronia da Letra e seus pesos
 * - Exibe status de sincronização com o histórico (salvo no servidor ou na fila local offline)
 * - Gráfico temporal de desempenho por trecho da música (`details.segments`)
 * - Estatísticas da partida: melhor sequência (streak), cobertura vocal e assistências
 */

import { standardMode } from "../game/modes/standard.js";
import { historyClient } from "../history/historyClient.js";
import { navigate } from "../router.js";
import { getState } from "../store.js";

const RESULT_CACHE_PREFIX = "karaoke.result.";

function saveResultSnapshot(entry) {
  if (!entry || !entry.id || typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(`${RESULT_CACHE_PREFIX}${entry.id}`, JSON.stringify(entry));
  } catch {
    // Ignora limite de armazenamento
  }
}

function loadResultSnapshot(sessionId) {
  const fromState = getState().lastResultEntry;
  if (fromState && (!sessionId || fromState.id === sessionId)) {
    saveResultSnapshot(fromState);
    return fromState;
  }

  if (sessionId && typeof window !== "undefined" && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(`${RESULT_CACHE_PREFIX}${sessionId}`);
      if (raw) return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return fromState || null;
}

function formatDuration(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDifficultyLabel(diff) {
  if (diff === "easy") return "Fácil";
  if (diff === "hard") return "Difícil";
  return "Normal";
}

function getDefaultWeightLabels(diff) {
  if (diff === "easy") return { pitchPct: 30, lyricPct: 70 };
  if (diff === "hard") return { pitchPct: 60, lyricPct: 40 };
  return { pitchPct: 40, lyricPct: 60 };
}

function normalizeSegmentScore(rawSeg) {
  if (rawSeg === null || rawSeg === undefined) return null;
  let numeric = null;
  if (typeof rawSeg === "number") {
    numeric = rawSeg;
  } else if (typeof rawSeg === "object") {
    numeric = rawSeg.score ?? rawSeg.accuracy ?? rawSeg.value ?? null;
  }
  if (!Number.isFinite(numeric)) return null;
  const scaled = numeric <= 1.0 ? numeric * 10 : numeric;
  return Math.max(0, Math.min(10, Number(scaled.toFixed(1))));
}

function buildConfidenceBanner(entry) {
  const confidence = entry.scoring_confidence || "medium";
  const compat = entry.compatibility_level || "regular";

  const alert = document.createElement("div");
  alert.className = "result-confidence-alert";
  alert.setAttribute("role", "status");

  const icon = document.createElement("span");
  icon.className = "result-confidence-icon";

  const text = document.createElement("div");

  if (confidence === "low" || compat === "low" || compat === "incompatible") {
    alert.dataset.level = "low";
    icon.textContent = "▲";
    text.textContent =
      "Nota estimada com baixa confiança: esta faixa possui pouca referência vocal isolada ou modo instrumental ativo. Use a pontuação apenas como referência divertida.";
  } else if (confidence === "high" && (compat === "excellent" || compat === "high")) {
    alert.dataset.level = "high";
    icon.textContent = "●";
    text.textContent =
      "Alta confiança na avaliação: voz guia isolada com nitidez e janelas de canto sincronizadas.";
  } else {
    alert.dataset.level = "medium";
    icon.textContent = "◐";
    text.textContent =
      "Confiança moderada na avaliação: trechos com backing vocals ou instrumentos intensos podem influenciar levemente a medição.";
  }

  alert.append(icon, text);
  return alert;
}

function buildSegmentsChart(segments, durationSec) {
  const card = document.createElement("section");
  card.className = "result-chart-card";

  const header = document.createElement("div");
  header.className = "result-chart-header";

  const heading = document.createElement("h3");
  heading.textContent = "Desempenho ao longo da música";

  const legend = document.createElement("div");
  legend.className = "result-chart-legend";

  const items = [
    { cls: "high", label: "Afinado (≥ 7.5)" },
    { cls: "mid", label: "Bom (4.5 – 7.4)" },
    { cls: "low", label: "Atenção (< 4.5)" },
  ];
  for (const item of items) {
    const span = document.createElement("span");
    const dot = document.createElement("span");
    dot.className = `legend-dot ${item.cls}`;
    span.append(dot, document.createTextNode(item.label));
    legend.appendChild(span);
  }

  header.append(heading, legend);
  card.appendChild(header);

  const normalized = Array.isArray(segments)
    ? segments.map(normalizeSegmentScore)
    : [];

  if (normalized.length === 0) {
    const emptyMsg = document.createElement("p");
    emptyMsg.className = "muted";
    emptyMsg.textContent = "Nenhum trecho vocal registrado durante esta partida.";
    card.appendChild(emptyMsg);
    return card;
  }

  const viewport = document.createElement("div");
  viewport.className = "result-bars-viewport";
  viewport.setAttribute("role", "img");
  viewport.setAttribute(
    "aria-label",
    `Gráfico de desempenho dividido em ${normalized.length} trechos da música`
  );

  normalized.forEach((val, idx) => {
    const col = document.createElement("div");
    col.className = "result-bar-col";

    const fill = document.createElement("div");
    fill.className = "result-bar-fill";

    if (val === null) {
      fill.dataset.band = "empty";
      fill.style.height = "8%";
      fill.title = `Trecho ${idx + 1}: instrumental / pausa`;
    } else {
      const pct = Math.max(8, Math.round((val / 10) * 100));
      fill.style.height = `${pct}%`;
      if (val >= 7.5) {
        fill.dataset.band = "high";
      } else if (val >= 4.5) {
        fill.dataset.band = "mid";
      } else {
        fill.dataset.band = "low";
      }
      fill.title = `Trecho ${idx + 1}: nota ${val.toFixed(1)} / 10`;
    }

    col.appendChild(fill);
    viewport.appendChild(col);
  });

  const axis = document.createElement("div");
  axis.className = "result-chart-axis";

  const startLabel = document.createElement("span");
  startLabel.textContent = "00:00 (Início)";

  const midLabel = document.createElement("span");
  midLabel.textContent = durationSec > 0 ? formatDuration(durationSec / 2) : "Meio";

  const endLabel = document.createElement("span");
  endLabel.textContent = durationSec > 0 ? `${formatDuration(durationSec)} (Fim)` : "Fim";

  axis.append(startLabel, midLabel, endLabel);
  card.append(viewport, axis);
  return card;
}

export function renderResultView(container, params) {
  const sessionId = params?.sessionId || "";
  const entry = loadResultSnapshot(sessionId);

  container.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "result-shell";

  if (!entry) {
    const emptyCard = document.createElement("section");
    emptyCard.className = "card";

    const title = document.createElement("h2");
    title.textContent = "Resultado não encontrado";

    const desc = document.createElement("p");
    desc.className = "muted";
    desc.textContent =
      "Os dados desta partida não estão disponíveis na sessão atual. Escolha uma música no catálogo para cantar.";

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "btn btn-primary";
    backBtn.textContent = "Voltar ao início";
    backBtn.addEventListener("click", () => navigate("/"));

    emptyCard.append(title, desc, backBtn);
    shell.appendChild(emptyCard);
    container.appendChild(shell);
    return;
  }

  const modeSummary = standardMode.summary({
    entry,
    persistence: getState().lastResultPersistence || null,
  });

  const { tier, verdict } = modeSummary;
  const details = entry.details || {};
  const assists = entry.assists || {};

  // 1. Hero Card (Título + Nota Final)
  const hero = document.createElement("section");
  hero.className = "result-hero-card";

  const metaCol = document.createElement("div");
  metaCol.className = "result-song-meta";

  const kicker = document.createElement("span");
  kicker.className = "result-kicker";
  kicker.textContent = "Resultado da Partida";

  const songTitle = document.createElement("h1");
  songTitle.className = "result-song-title";
  songTitle.textContent = entry.song_title || entry.video_id || "Música";

  const artistSub = document.createElement("p");
  artistSub.className = "result-song-subtitle";
  artistSub.textContent = entry.artist
    ? `${entry.artist} • Jogador: ${entry.player_name || "Convidado"}`
    : `Jogador: ${entry.player_name || "Convidado"}`;

  const badgesRow = document.createElement("div");
  badgesRow.className = "result-badges-row";

  const diffPill = document.createElement("span");
  diffPill.className = "pill";
  diffPill.textContent = `Dificuldade: ${formatDifficultyLabel(entry.difficulty)}`;
  badgesRow.appendChild(diffPill);

  if (entry.duration_s > 0) {
    const durPill = document.createElement("span");
    durPill.className = "pill";
    durPill.textContent = `Duração: ${formatDuration(entry.duration_s)}`;
    badgesRow.appendChild(durPill);
  }

  if (assists.auto_transpose) {
    const shift = modeSummary.transpositionSemitones;
    const transpPill = document.createElement("span");
    transpPill.className = "pill synced";
    transpPill.textContent =
      shift !== 0
        ? `Tom ajustado (${shift > 0 ? `+${shift}` : shift} st)`
        : "Ajuste de tom ativo";
    badgesRow.appendChild(transpPill);
  }

  if (Number(assists.guide_volume) > 0) {
    const guidePill = document.createElement("span");
    guidePill.className = "pill";
    guidePill.textContent = `Voz guia: ${Math.round(Number(assists.guide_volume) * 100)}%`;
    badgesRow.appendChild(guidePill);
  }

  // Indicador de persistência no histórico (sincronizado vs fila local offline)
  const syncPill = document.createElement("span");
  syncPill.className = "pill";
  const updateSyncPill = () => {
    const isPending = historyClient
      .getPendingEntries()
      .some((item) => item?.id === entry.id);
    if (isPending) {
      syncPill.textContent = "Salvo localmente (aguardando servidor)";
    } else if (modeSummary.persistence?.skipped) {
      syncPill.textContent = "Partida não registrada no histórico";
    } else {
      syncPill.textContent = "Salvo no histórico";
    }
  };
  updateSyncPill();
  badgesRow.appendChild(syncPill);

  const unsubscribePending = historyClient.subscribePending(() => {
    updateSyncPill();
  });

  metaCol.append(kicker, songTitle, artistSub, badgesRow);

  const scoreBox = document.createElement("div");
  scoreBox.className = "result-score-box";
  scoreBox.dataset.tier = tier;

  const scoreVal = document.createElement("div");
  scoreVal.className = "result-score-value";
  scoreVal.textContent = modeSummary.scoreFormatted;

  const scoreScale = document.createElement("div");
  scoreScale.className = "result-score-scale";
  scoreScale.textContent = "de 10.0 pontos";

  const verdictBadge = document.createElement("div");
  verdictBadge.className = "result-score-verdict";
  verdictBadge.textContent = verdict;

  scoreBox.append(scoreVal, scoreScale, verdictBadge);
  hero.append(metaCol, scoreBox);
  shell.appendChild(hero);

  // 2. Banner de Confiança da Nota
  shell.appendChild(buildConfidenceBanner(entry));

  // 3. Grade de Métricas + Detalhamento Híbrido (Afinação vs. Letra)
  const statsGrid = document.createElement("section");
  statsGrid.className = "result-stats-grid";

  const defaults = getDefaultWeightLabels(entry.difficulty);
  const pitchPct = modeSummary.weights
    ? Math.round(Number(modeSummary.weights.pitch) * 100)
    : defaults.pitchPct;
  const lyricPct = modeSummary.weights
    ? Math.round(Number(modeSummary.weights.lyrics) * 100)
    : defaults.lyricPct;

  const bestStreakFrames = modeSummary.bestStreak;
  const bestStreakSec = (bestStreakFrames * 0.02).toFixed(1);
  const coveragePct = Math.round(modeSummary.coverage * 100);

  const statItems = [
    {
      label: "Afinação (Melodia)",
      value: `${modeSummary.pitchScore.toFixed(1)} / 10`,
      hint: `Peso na nota: ${pitchPct}% (${formatDifficultyLabel(entry.difficulty)})`,
    },
    {
      label: "Sincronia da Letra",
      value: `${modeSummary.lyricScore.toFixed(1)} / 10`,
      hint: modeSummary.hasSyncedLyrics
        ? `Peso na nota: ${lyricPct}% • Versos no tempo`
        : `Peso na nota: ${lyricPct}% • Frases vocais`,
    },
    {
      label: "Melhor sequência",
      value: `${bestStreakFrames} notas`,
      hint: `~${bestStreakSec}s seguidos afinados`,
    },
    {
      label: "Cobertura vocal",
      value: `${coveragePct}%`,
      hint: "Trechos cantados da faixa",
    },
  ];

  for (const st of statItems) {
    const card = document.createElement("div");
    card.className = "result-stat-card";

    const lbl = document.createElement("span");
    lbl.className = "result-stat-label";
    lbl.textContent = st.label;

    const val = document.createElement("span");
    val.className = "result-stat-value";
    val.textContent = st.value;

    const hint = document.createElement("span");
    hint.className = "result-stat-hint";
    hint.textContent = st.hint;

    card.append(lbl, val, hint);
    statsGrid.appendChild(card);
  }

  shell.appendChild(statsGrid);

  // 4. Gráfico Temporal por Trecho
  shell.appendChild(buildSegmentsChart(details.segments, entry.duration_s));

  // 5. Botões de Ação
  const actionsBar = document.createElement("div");
  actionsBar.className = "result-actions-bar";

  const homeBtn = document.createElement("button");
  homeBtn.type = "button";
  homeBtn.className = "btn btn-secondary";
  homeBtn.textContent = "Escolher outra música";
  homeBtn.addEventListener("click", () => navigate("/"));

  const historyBtn = document.createElement("button");
  historyBtn.type = "button";
  historyBtn.className = "btn btn-secondary";
  historyBtn.textContent = "Ver histórico";
  historyBtn.addEventListener("click", () => navigate("/history"));

  actionsBar.append(homeBtn, historyBtn);

  if (entry.video_id) {
    const replayBtn = document.createElement("button");
    replayBtn.type = "button";
    replayBtn.className = "btn btn-primary";
    replayBtn.textContent = "Cantar novamente";
    replayBtn.addEventListener("click", () => {
      navigate(`/play/${encodeURIComponent(entry.video_id)}`);
    });
    actionsBar.appendChild(replayBtn);
  }

  shell.appendChild(actionsBar);
  container.appendChild(shell);

  return () => {
    unsubscribePending();
  };
}