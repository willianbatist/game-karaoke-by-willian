/**
 * Tela de Resultado (#/result/:sessionId) — T3.4:
 * - Exibe nota final (0.0 a 10.0) com classificação motivacional
 * - Gráfico temporal de desempenho por trecho da música (`details.segments`)
 * - Estatísticas da partida: melhor sequência (streak), cobertura vocal e assistências
 * - Indicador de confiança da nota (`scoring_confidence` / `compatibility_level`)
 * - Botões de ação: Cantar novamente, Escolher outra música e Histórico
 */

import { navigate } from "../router.js";
import { getState } from "../store.js";

const RESULT_CACHE_PREFIX = "karaoke.result.";

function saveResultSnapshot(entry) {
  if (!entry || !entry.id || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(`${RESULT_CACHE_PREFIX}${entry.id}`, JSON.stringify(entry));
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

  if (sessionId && typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(`${RESULT_CACHE_PREFIX}${sessionId}`);
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

function classifyScore(score) {
  const val = Number(score) || 0;
  if (val >= 8.5) {
    return { tier: "excellent", verdict: "Performance brilhante!" };
  }
  if (val >= 6.5) {
    return { tier: "good", verdict: "Ótima interpretação!" };
  }
  if (val >= 4.0) {
    return { tier: "fair", verdict: "Bom aquecimento!" };
  }
  return { tier: "starter", verdict: "Continue praticando!" };
}

/**
 * Normaliza cada elemento de `segments` para uma nota no intervalo [0, 10]
 * (aceita tanto valores em [0, 1] quanto [0, 10] ou objetos { score / accuracy }).
 */
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

  if (confidence === "low" || compat === "low" || compat === "instrumental") {
    alert.dataset.level = "low";
    icon.textContent = "▲";
    text.textContent =
      "Nota estimada com baixa confiança: esta faixa possui pouca referência vocal isolada ou modo instrumental ativo. Use a pontuação apenas como referência divertida.";
  } else if (confidence === "high" && compat === "high") {
    alert.dataset.level = "high";
    icon.textContent = "●";
    text.textContent =
      "Alta confiança na avaliação: voz guia isolada com nitidez e sincronização estável.";
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

  const scoreNum = Math.max(0, Math.min(10, Number(entry.score) || 0));
  const { tier, verdict } = classifyScore(scoreNum);
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
    const transpPill = document.createElement("span");
    transpPill.className = "pill synced";
    transpPill.textContent = "Transposição automática";
    badgesRow.appendChild(transpPill);
  }

  if (Number(assists.guide_volume) > 0) {
    const guidePill = document.createElement("span");
    guidePill.className = "pill";
    guidePill.textContent = `Voz guia: ${Math.round(Number(assists.guide_volume) * 100)}%`;
    badgesRow.appendChild(guidePill);
  }

  metaCol.append(kicker, songTitle, artistSub, badgesRow);

  const scoreBox = document.createElement("div");
  scoreBox.className = "result-score-box";
  scoreBox.dataset.tier = tier;

  const scoreVal = document.createElement("div");
  scoreVal.className = "result-score-value";
  scoreVal.textContent = scoreNum.toFixed(1);

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

  // 3. Grade de Métricas
  const statsGrid = document.createElement("section");
  statsGrid.className = "result-stats-grid";

  const bestStreakFrames = Math.max(0, Math.round(Number(details.best_streak) || 0));
  const bestStreakSec = (bestStreakFrames * 0.02).toFixed(1);
  const coveragePct = Math.round(Math.max(0, Math.min(1, Number(details.coverage) || 0)) * 100);

  const statItems = [
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
    {
      label: "Modo de partida",
      value: entry.completed ? "Concluída" : "Parcial",
      hint: `Dificuldade ${formatDifficultyLabel(entry.difficulty)}`,
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
}