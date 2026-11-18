/**
 * Tela de Histórico, Rankings e Exportação (#/historico) — FRONTEND_ARCHITECTURE.md §5.3 e T4.6.2:
 * - Status da fila offline (`karaoke.pendingHistory.v1`) com botão de sincronização manual
 * - Aba 1: Partidas Recentes (filtros por jogador, música, dificuldade e período + modal de detalhes + exclusão)
 * - Aba 2: Rankings por Música (Top 10 geral + melhor nota por jogador)
 * - Aba 3: Exportar (CSV PT-BR, CSV Internacional ou TXT) e Limpar Histórico
 */

import { api } from "../api.js";
import { historyClient } from "../history/historyClient.js";
import { playerStore } from "../players/playerStore.js";
import { navigate } from "../router.js";
import { getState, showBanner } from "../store.js";
import { createCompatibilityBadge } from "../ui/components/compatibilityBadge.js";
import { confirmDialog } from "../ui/confirmModal.js";

const DIFFICULTY_LABELS = {
  easy: "Fácil",
  normal: "Normal",
  hard: "Difícil",
};

function formatDateTimePt(isoStr) {
  if (!isoStr) return "-";
  const ts = Date.parse(isoStr);
  if (Number.isNaN(ts)) return "-";
  return new Date(ts).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function renderHistoryView(container) {
  let disposed = false;
  let activeTab = "entries"; // "entries" | "rankings" | "export"
  let cachedEntries = [];

  container.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "manage-shell";

  // Cabeçalho + abas
  const headerCard = document.createElement("section");
  headerCard.className = "card";

  const topRow = document.createElement("div");
  topRow.className = "section-header-row";

  const titleEl = document.createElement("h1");
  titleEl.textContent = "Histórico e Rankings";

  // Banner de partidas pendentes offline
  const syncBox = document.createElement("div");
  syncBox.className = "pending-sync-box";
  syncBox.hidden = true;

  const syncText = document.createElement("span");
  const syncNowBtn = document.createElement("button");
  syncNowBtn.type = "button";
  syncNowBtn.className = "btn btn-primary";
  syncNowBtn.textContent = "Sincronizar agora";

  syncNowBtn.addEventListener("click", async () => {
    syncNowBtn.disabled = true;
    try {
      const res = await historyClient.flushPending();
      if (res.flushed > 0) {
        showBanner("success", `${res.flushed} partida(s) sincronizada(s) com sucesso!`);
        await refreshEntries();
      } else {
        showBanner("warning", "Ainda não foi possível conectar ao servidor local.");
      }
    } finally {
      syncNowBtn.disabled = false;
      updatePendingBanner();
    }
  });

  syncBox.append(syncText, syncNowBtn);
  topRow.append(titleEl, syncBox);

  function updatePendingBanner() {
    const count = historyClient.getPendingCount();
    syncBox.hidden = count === 0;
    if (count > 0) {
      syncText.textContent = `${count} partida(s) aguardando sincronização local`;
    }
  }

  updatePendingBanner();
  const unsubPending = historyClient.subscribePending(() => {
    if (!disposed) updatePendingBanner();
  });

  // Navegação por abas
  const tabsBar = document.createElement("div");
  tabsBar.className = "tabs-bar";
  tabsBar.setAttribute("role", "tablist");

  const tabDefs = [
    { id: "entries", label: "Partidas Recentes" },
    { id: "rankings", label: "Rankings por Música" },
    { id: "export", label: "Exportar e Limpar" },
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

  headerCard.append(topRow, tabsBar);
  shell.appendChild(headerCard);

  // =========================================================================
  // PAINEL 1: PARTIDAS RECENTES
  // =========================================================================
  const entriesPanel = document.createElement("section");
  entriesPanel.className = "card";
  tabPanels.set("entries", entriesPanel);

  const filtersGrid = document.createElement("div");
  filtersGrid.className = "history-filters-grid";

  // Filtro Jogador
  const playerFilter = document.createElement("select");
  playerFilter.className = "select-control";
  playerFilter.setAttribute("aria-label", "Filtrar por jogador");

  // Filtro Música
  const songFilter = document.createElement("select");
  songFilter.className = "select-control";
  songFilter.setAttribute("aria-label", "Filtrar por música");

  // Filtro Dificuldade
  const diffFilter = document.createElement("select");
  diffFilter.className = "select-control";
  diffFilter.setAttribute("aria-label", "Filtrar por dificuldade");
  for (const optDef of [
    { value: "", label: "Todas as dificuldades" },
    { value: "easy", label: "Fácil" },
    { value: "normal", label: "Normal" },
    { value: "hard", label: "Difícil" },
  ]) {
    const opt = document.createElement("option");
    opt.value = optDef.value;
    opt.textContent = optDef.label;
    diffFilter.appendChild(opt);
  }

  // Filtro Data Inicial e Final
  const fromInput = document.createElement("input");
  fromInput.type = "date";
  fromInput.className = "text-input";
  fromInput.setAttribute("aria-label", "Data inicial");

  const toInput = document.createElement("input");
  toInput.type = "date";
  toInput.className = "text-input";
  toInput.setAttribute("aria-label", "Data final");

  const clearFiltersBtn = document.createElement("button");
  clearFiltersBtn.type = "button";
  clearFiltersBtn.className = "btn btn-secondary";
  clearFiltersBtn.textContent = "Limpar filtros";

  filtersGrid.append(playerFilter, songFilter, diffFilter, fromInput, toInput, clearFiltersBtn);

  const entriesSummary = document.createElement("p");
  entriesSummary.className = "muted";
  entriesSummary.textContent = "Carregando partidas...";

  const entriesListHost = document.createElement("div");
  entriesListHost.className = "history-list";

  entriesPanel.append(filtersGrid, entriesSummary, entriesListHost);

  // Modal de detalhes da partida
  const detailBackdrop = document.createElement("div");
  detailBackdrop.className = "modal-backdrop";
  detailBackdrop.hidden = true;
  detailBackdrop.setAttribute("role", "dialog");
  detailBackdrop.setAttribute("aria-modal", "true");
  detailBackdrop.setAttribute("aria-label", "Detalhes da partida");

  const detailDialog = document.createElement("div");
  detailDialog.className = "modal-dialog history-detail-dialog";

  const detailTitle = document.createElement("h3");
  detailTitle.className = "modal-title";

  const detailBody = document.createElement("div");
  detailBody.className = "history-detail-body";

  const detailActions = document.createElement("div");
  detailActions.className = "modal-actions";

  const detailReplayBtn = document.createElement("button");
  detailReplayBtn.type = "button";
  detailReplayBtn.className = "btn btn-primary";
  detailReplayBtn.textContent = "Cantar esta música";

  const detailCloseBtn = document.createElement("button");
  detailCloseBtn.type = "button";
  detailCloseBtn.className = "btn btn-secondary";
  detailCloseBtn.textContent = "Fechar";
  detailCloseBtn.addEventListener("click", () => {
    detailBackdrop.hidden = true;
  });

  detailActions.append(detailCloseBtn, detailReplayBtn);
  detailDialog.append(detailTitle, detailBody, detailActions);
  detailBackdrop.appendChild(detailDialog);

  function openEntryDetailModal(entry) {
    detailTitle.textContent = `${entry.song_title} — ${entry.player_name}`;
    detailBody.replaceChildren();

    const rows = [
      ["Nota final", `${Number(entry.score).toFixed(1)} / 10.0`],
      ["Jogador", entry.player_name],
      ["Dificuldade", DIFFICULTY_LABELS[entry.difficulty] || entry.difficulty],
      ["Data e hora", formatDateTimePt(entry.played_at)],
      ["Melhor sequência", `${entry.details?.best_streak ?? 0} nota(s)`],
      ["Cobertura vocal", `${Math.round((Number(entry.details?.coverage) || 0) * 100)}%`],
      ["Confiança da pontuação", entry.scoring_confidence === "high" ? "Alta" : "Baixa (heurística/baixa compatibilidade)"],
      ["Qualidade do microfone", entry.mic_quality || "Não registrada"],
      ["Auto-transposição", entry.assists?.auto_transpose ? "Ativada" : "Desativada"],
      ["Volume da voz guia", `${Math.round((Number(entry.assists?.guide_volume) || 0) * 100)}%`],
      ["Status da partida", entry.completed ? "Concluída" : "Encerrada antes do fim"],
    ];

    for (const [label, val] of rows) {
      const r = document.createElement("div");
      r.className = "history-detail-row";
      const k = document.createElement("span");
      k.className = "muted";
      k.textContent = label;
      const v = document.createElement("strong");
      v.textContent = String(val);
      r.append(k, v);
      detailBody.appendChild(r);
    }

    detailReplayBtn.onclick = () => {
      detailBackdrop.hidden = true;
      navigate(`/pre-jogo/${encodeURIComponent(entry.video_id)}`);
    };

    detailBackdrop.hidden = false;
  }

  function populateFilterDropdowns() {
    const players = playerStore.getPlayers();
    const prevPlayer = playerFilter.value;
    playerFilter.replaceChildren();

    const allP = document.createElement("option");
    allP.value = "";
    allP.textContent = "Todos os jogadores";
    playerFilter.appendChild(allP);

    for (const p of players) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      if (p.id === prevPlayer) opt.selected = true;
      playerFilter.appendChild(opt);
    }

    // Músicas únicas (união do cache + histórico)
    const songMap = new Map();
    for (const s of getState().songs || []) {
      songMap.set(s.videoId, s.title || s.videoId);
    }
    for (const e of cachedEntries) {
      if (!songMap.has(e.video_id)) {
        songMap.set(e.video_id, e.song_title || e.video_id);
      }
    }

    const prevSong = songFilter.value;
    songFilter.replaceChildren();
    const allS = document.createElement("option");
    allS.value = "";
    allS.textContent = "Todas as músicas";
    songFilter.appendChild(allS);

    for (const [vid, title] of songMap.entries()) {
      const opt = document.createElement("option");
      opt.value = vid;
      opt.textContent = title;
      if (vid === prevSong) opt.selected = true;
      songFilter.appendChild(opt);
    }
  }

  function renderEntriesList(entries) {
    entriesListHost.replaceChildren();
    entriesSummary.textContent = `${entries.length} partida(s) encontrada(s)`;

    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Nenhuma partida encontrada com os filtros atuais.";
      entriesListHost.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement("article");
      row.className = "history-entry-card";

      const scoreBadge = document.createElement("div");
      scoreBadge.className = "history-score-box mono";
      scoreBadge.textContent = Number(entry.score).toFixed(1);

      const info = document.createElement("div");
      info.className = "history-entry-info";

      const titleLine = document.createElement("div");
      titleLine.className = "library-item-title-row";

      const songTitle = document.createElement("strong");
      songTitle.textContent = entry.song_title || entry.video_id;

      const playerPill = document.createElement("span");
      playerPill.className = "pill synced";
      playerPill.textContent = entry.player_name;

      const diffPill = document.createElement("span");
      diffPill.className = "pill";
      diffPill.textContent = DIFFICULTY_LABELS[entry.difficulty] || entry.difficulty;

      titleLine.append(songTitle, playerPill, diffPill);

      if (entry.compatibility_level) {
        titleLine.appendChild(
          createCompatibilityBadge(
            { level: entry.compatibility_level },
            { compact: true, showReasons: false }
          )
        );
      }

      const subLine = document.createElement("div");
      subLine.className = "muted";
      subLine.textContent = `${formatDateTimePt(entry.played_at)} • Melhor sequência: ${entry.details?.best_streak ?? 0} • Cobertura: ${Math.round((Number(entry.details?.coverage) || 0) * 100)}%`;

      info.append(titleLine, subLine);

      const actions = document.createElement("div");
      actions.className = "library-item-actions";

      const detailBtn = document.createElement("button");
      detailBtn.type = "button";
      detailBtn.className = "btn btn-secondary";
      detailBtn.textContent = "Detalhes";
      detailBtn.addEventListener("click", () => openEntryDetailModal(entry));

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-danger";
      delBtn.textContent = "Excluir";
      delBtn.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "Excluir partida do histórico?",
          message: `Deseja remover o registro de ${entry.player_name} em "${entry.song_title}" (${Number(entry.score).toFixed(1)})?`,
          confirmText: "Excluir",
          danger: true,
        });
        if (!ok || disposed) return;

        try {
          await historyClient.deleteEntry(entry.id);
          showBanner("info", "Registro removido do histórico.");
          await refreshEntries();
        } catch (err) {
          showBanner("error", err.message);
        }
      });

      actions.append(detailBtn, delBtn);
      row.append(scoreBadge, info, actions);
      entriesListHost.appendChild(row);
    }
  }

  async function refreshEntries() {
    try {
      const filters = {
        playerId: playerFilter.value,
        videoId: songFilter.value,
        difficulty: diffFilter.value,
        from: fromInput.value ? `${fromInput.value}T00:00:00.000Z` : "",
        to: toInput.value ? `${toInput.value}T23:59:59.999Z` : "",
      };
      const res = await historyClient.listHistory(filters);
      if (disposed) return;
      const entries = Array.isArray(res?.entries) ? res.entries : [];
      if (!filters.playerId && !filters.videoId && !filters.difficulty && !filters.from && !filters.to) {
        cachedEntries = entries;
      }
      populateFilterDropdowns();
      renderEntriesList(entries);
    } catch (err) {
      if (!disposed) {
        entriesSummary.textContent = `Não foi possível carregar o histórico: ${err.message}`;
      }
    }
  }

  for (const el of [playerFilter, songFilter, diffFilter, fromInput, toInput]) {
    el.addEventListener("change", refreshEntries);
  }

  clearFiltersBtn.addEventListener("click", () => {
    playerFilter.value = "";
    songFilter.value = "";
    diffFilter.value = "";
    fromInput.value = "";
    toInput.value = "";
    refreshEntries();
  });

  // =========================================================================
  // PAINEL 2: RANKINGS POR MÚSICA
  // =========================================================================
  const rankingsPanel = document.createElement("section");
  rankingsPanel.className = "card";
  rankingsPanel.hidden = true;
  tabPanels.set("rankings", rankingsPanel);

  const rankHeaderRow = document.createElement("div");
  rankHeaderRow.className = "section-header-row";

  const rankHeading = document.createElement("h2");
  rankHeading.textContent = "Ranking por Música";

  const rankSongSelect = document.createElement("select");
  rankSongSelect.className = "select-control";
  rankSongSelect.setAttribute("aria-label", "Escolher música para ver o ranking");

  rankHeaderRow.append(rankHeading, rankSongSelect);

  const rankContentHost = document.createElement("div");
  rankContentHost.className = "rankings-columns";

  rankingsPanel.append(rankHeaderRow, rankContentHost);

  function populateRankingSongs() {
    const songMap = new Map();
    for (const s of getState().songs || []) {
      songMap.set(s.videoId, s.title || s.videoId);
    }
    for (const e of cachedEntries) {
      if (!songMap.has(e.video_id)) {
        songMap.set(e.video_id, e.song_title || e.video_id);
      }
    }

    const prev = rankSongSelect.value;
    rankSongSelect.replaceChildren();

    if (songMap.size === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Nenhuma música com partidas ainda";
      rankSongSelect.appendChild(opt);
      return;
    }

    for (const [vid, title] of songMap.entries()) {
      const opt = document.createElement("option");
      opt.value = vid;
      opt.textContent = title;
      if (vid === prev) opt.selected = true;
      rankSongSelect.appendChild(opt);
    }
  }

  async function loadRankingForSelectedSong() {
    populateRankingSongs();
    const videoId = rankSongSelect.value;
    rankContentHost.replaceChildren();

    if (!videoId) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Cante pelo menos uma música para gerar rankings locais.";
      rankContentHost.appendChild(empty);
      return;
    }

    try {
      const [data, allSongHist] = await Promise.all([
        historyClient.getRankings(videoId),
        historyClient.listHistory({ videoId }).catch(() => ({ entries: [] })),
      ]);
      if (disposed) return;

      const personalBests = Array.isArray(data?.entries) ? data.entries : [];
      const allCompleted = (Array.isArray(allSongHist?.entries) ? allSongHist.entries : [])
        .filter((item) => item.completed === true)
        .sort((a, b) => Number(b.score) - Number(a.score));
      const top10 = (allCompleted.length > 0 ? allCompleted : personalBests).slice(0, 10);

      // Coluna 1: Top 10 Geral
      const topCol = document.createElement("div");
      topCol.className = "ranking-box";
      const topTitle = document.createElement("h3");
      topTitle.textContent = "Top 10 Geral";
      topCol.appendChild(topTitle);

      if (top10.length === 0) {
        const p = document.createElement("p");
        p.className = "muted";
        p.textContent = "Nenhuma partida concluída para esta música ainda.";
        topCol.appendChild(p);
      } else {
        const list = document.createElement("ol");
        list.className = "ranking-list";
        top10.forEach((item, idx) => {
          const li = document.createElement("li");
          li.className = "ranking-row";
          const left = document.createElement("span");
          left.textContent = `#${idx + 1} ${item.player_name} (${DIFFICULTY_LABELS[item.difficulty] || item.difficulty})`;
          const right = document.createElement("strong");
          right.className = "mono";
          right.textContent = Number(item.best_score ?? item.score).toFixed(1);
          li.append(left, right);
          list.appendChild(li);
        });
        topCol.appendChild(list);
      }

      // Coluna 2: Melhor por Jogador
      const pbCol = document.createElement("div");
      pbCol.className = "ranking-box";
      const pbTitle = document.createElement("h3");
      pbTitle.textContent = "Recorde por Jogador";
      pbCol.appendChild(pbTitle);

      if (personalBests.length === 0) {
        const p = document.createElement("p");
        p.className = "muted";
        p.textContent = "Sem recordes individuais registrados.";
        pbCol.appendChild(p);
      } else {
        const list = document.createElement("ul");
        list.className = "ranking-list";
        for (const item of personalBests) {
          const li = document.createElement("li");
          li.className = "ranking-row";
          const left = document.createElement("span");
          left.textContent = `${item.player_name} • ${formatDateTimePt(item.played_at)}`;
          const right = document.createElement("strong");
          right.className = "mono";
          right.textContent = Number(item.best_score ?? item.score).toFixed(1);
          li.append(left, right);
          list.appendChild(li);
        }
        pbCol.appendChild(list);
      }

      rankContentHost.append(topCol, pbCol);
    } catch (err) {
      const errP = document.createElement("p");
      errP.className = "muted";
      errP.textContent = `Erro ao carregar ranking: ${err.message}`;
      rankContentHost.appendChild(errP);
    }
  }

  rankSongSelect.addEventListener("change", loadRankingForSelectedSong);

  // =========================================================================
  // PAINEL 3: EXPORTAR E LIMPAR HISTÓRICO
  // =========================================================================
  const exportPanel = document.createElement("section");
  exportPanel.className = "card";
  exportPanel.hidden = true;
  tabPanels.set("export", exportPanel);

  const expHeading = document.createElement("h2");
  expHeading.textContent = "Exportar Histórico";

  const expDesc = document.createElement("p");
  expDesc.className = "muted";
  expDesc.textContent =
    "Gere uma planilha CSV compatível com Excel/Google Sheets ou um relatório resumido em TXT.";

  const expControls = document.createElement("div");
  expControls.className = "export-controls-grid";

  const expPlayerSelect = document.createElement("select");
  expPlayerSelect.className = "select-control";
  expPlayerSelect.setAttribute("aria-label", "Jogador para exportação");

  const expPresetSelect = document.createElement("select");
  expPresetSelect.className = "select-control";
  expPresetSelect.setAttribute("aria-label", "Formato de exportação");
  for (const optDef of [
    { value: "csv-ptbr", label: "CSV Excel PT-BR (separador ; e vírgula decimal)" },
    { value: "csv-intl", label: "CSV Internacional (separador , e ponto decimal)" },
    { value: "txt", label: "TXT (Resumo legível em texto)" },
  ]) {
    const opt = document.createElement("option");
    opt.value = optDef.value;
    opt.textContent = optDef.label;
    expPresetSelect.appendChild(opt);
  }

  const downloadBtn = document.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.className = "btn btn-primary";
  downloadBtn.textContent = "Baixar arquivo";

  downloadBtn.addEventListener("click", () => {
    const preset = expPresetSelect.value;
    const playerId = expPlayerSelect.value;
    let url = "";
    if (preset === "txt") {
      url = historyClient.getExportUrl({ format: "txt", playerId });
    } else if (preset === "csv-intl") {
      url = historyClient.getExportUrl({
        format: "csv",
        playerId,
        bom: "1",
        sep: ",",
        decimal: "dot",
      });
    } else {
      url = historyClient.getExportUrl({
        format: "csv",
        playerId,
        bom: "1",
        sep: ";",
        decimal: "comma",
      });
    }
    window.location.assign(url);
  });

  expControls.append(expPlayerSelect, expPresetSelect, downloadBtn);

  const dangerDivider = document.createElement("hr");
  dangerDivider.className = "manage-divider";

  const clearHeading = document.createElement("h2");
  clearHeading.textContent = "Limpar Histórico";

  const clearDesc = document.createElement("p");
  clearDesc.className = "muted";
  clearDesc.textContent =
    "Apaga permanentemente as partidas salvas no arquivo local. Esta ação não remove suas músicas baixadas.";

  const clearActions = document.createElement("div");
  clearActions.className = "library-item-actions";

  const clearPlayerBtn = document.createElement("button");
  clearPlayerBtn.type = "button";
  clearPlayerBtn.className = "btn btn-secondary";
  clearPlayerBtn.textContent = "Limpar histórico do jogador selecionado";

  const clearAllBtn = document.createElement("button");
  clearAllBtn.type = "button";
  clearAllBtn.className = "btn btn-danger";
  clearAllBtn.textContent = "Limpar TODO o histórico";

  clearPlayerBtn.addEventListener("click", async () => {
    const targetPlayerId = expPlayerSelect.value;
    if (!targetPlayerId) {
      showBanner("warning", "Selecione um jogador específico acima para limpar apenas o histórico dele.");
      return;
    }
    const label = expPlayerSelect.options[expPlayerSelect.selectedIndex]?.textContent || targetPlayerId;
    const ok = await confirmDialog({
      title: "Limpar histórico do jogador?",
      message: `Todas as partidas registradas de "${label}" serão apagadas permanentemente.`,
      confirmText: "Apagar partidas",
      danger: true,
    });
    if (!ok || disposed) return;

    try {
      await historyClient.clearHistory({ playerId: targetPlayerId, confirm: "DELETE_PLAYER" });
      showBanner("info", `Histórico de "${label}" apagado.`);
      await refreshEntries();
    } catch (err) {
      showBanner("error", err.message);
    }
  });

  clearAllBtn.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Apagar TODO o histórico?",
      message: "Todas as partidas de todos os jogadores e rankings serão apagados permanentemente.",
      confirmText: "Apagar tudo",
      danger: true,
    });
    if (!ok || disposed) return;

    try {
      await historyClient.clearHistory({ confirm: "DELETE_ALL" });
      cachedEntries = [];
      showBanner("info", "Todo o histórico foi apagado.");
      await refreshEntries();
    } catch (err) {
      showBanner("error", err.message);
    }
  });

  clearActions.append(clearPlayerBtn, clearAllBtn);
  exportPanel.append(expHeading, expDesc, expControls, dangerDivider, clearHeading, clearDesc, clearActions);

  function populateExportPlayers() {
    const players = playerStore.getPlayers();
    expPlayerSelect.replaceChildren();
    const allOpt = document.createElement("option");
    allOpt.value = "";
    allOpt.textContent = "Todos os jogadores";
    expPlayerSelect.appendChild(allOpt);

    for (const p of players) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      expPlayerSelect.appendChild(opt);
    }
  }

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

    if (activeTab === "rankings") {
      loadRankingForSelectedSong();
    } else if (activeTab === "export") {
      populateExportPlayers();
    }
  }

  shell.append(entriesPanel, rankingsPanel, exportPanel, detailBackdrop);
  container.appendChild(shell);

  refreshEntries();

  return () => {
    disposed = true;
    unsubPending();
  };
}