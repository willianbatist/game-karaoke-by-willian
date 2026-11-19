/**
 * Tela de Biblioteca Local (#/biblioteca) — FRONTEND_ARCHITECTURE.md §5.3 e T4.6.1:
 * - Lista músicas preparadas no cache (GET /api/songs?q=&sort=)
 * - Exibe espaço total ocupado em disco, busca, filtro rápido "Favoritas ★" e ordenação
 * - Ações por música: Favoritar (★), Cantar (#/pre-jogo/:videoId), Reprocessar e Excluir do cache
 */

import { api } from "../api.js";
import { navigate } from "../router.js";
import { setState, showBanner } from "../store.js";
import { createCompatibilityBadge } from "../ui/components/compatibilityBadge.js";
import { createFavoriteButton } from "../ui/components/favoriteButton.js";
import { confirmDialog } from "../ui/confirmModal.js";

function formatDuration(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  const val = Number(bytes) || 0;
  if (val <= 0) return "0 MB";
  const mb = val / (1024 * 1024);
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatDatePt(isoStr) {
  if (!isoStr) return "Nunca tocada";
  const ts = Date.parse(isoStr);
  if (Number.isNaN(ts)) return "Nunca tocada";
  return new Date(ts).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function renderLibraryView(container) {
  let disposed = false;
  let currentQuery = "";
  let currentSort = "recent";
  let onlyFavorites = false;
  let lastLoadedData = { songs: [], totalCount: 0, totalSizeBytes: 0 };
  let debounceTimer = null;

  container.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "manage-shell";

  // Cabeçalho + controles de busca/ordenação
  const headerCard = document.createElement("section");
  headerCard.className = "card";

  const topRow = document.createElement("div");
  topRow.className = "section-header-row";

  const titleWrap = document.createElement("div");
  const titleEl = document.createElement("h1");
  titleEl.textContent = "Biblioteca Local";
  const summaryEl = document.createElement("p");
  summaryEl.className = "muted";
  summaryEl.textContent = "Carregando músicas armazenadas no cache...";
  titleWrap.append(titleEl, summaryEl);

  const newSongBtn = document.createElement("button");
  newSongBtn.type = "button";
  newSongBtn.className = "btn btn-primary";
  newSongBtn.textContent = "+ Preparar nova música";
  newSongBtn.addEventListener("click", () => navigate("/"));

  topRow.append(titleWrap, newSongBtn);

  const controlsBar = document.createElement("div");
  controlsBar.className = "library-controls-bar";

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "text-input";
  searchInput.placeholder = "Filtrar por título, artista ou ID do vídeo...";
  searchInput.setAttribute("aria-label", "Filtrar músicas da biblioteca");

  const favFilterBtn = document.createElement("button");
  favFilterBtn.type = "button";
  favFilterBtn.className = "btn btn-secondary filter-toggle-btn";
  favFilterBtn.setAttribute("aria-pressed", "false");
  favFilterBtn.textContent = "★ Favoritas";
  favFilterBtn.addEventListener("click", () => {
    onlyFavorites = !onlyFavorites;
    favFilterBtn.classList.toggle("active", onlyFavorites);
    favFilterBtn.setAttribute("aria-pressed", onlyFavorites ? "true" : "false");
    renderSongsList(lastLoadedData);
  });

  const sortSelect = document.createElement("select");
  sortSelect.className = "select-control";
  sortSelect.setAttribute("aria-label", "Ordenar biblioteca por");
  for (const optDef of [
    { value: "recent", label: "Ordenar: Mais recentes" },
    { value: "title", label: "Ordenar: Título (A–Z)" },
    { value: "size", label: "Ordenar: Maior tamanho" },
  ]) {
    const opt = document.createElement("option");
    opt.value = optDef.value;
    opt.textContent = optDef.label;
    sortSelect.appendChild(opt);
  }

  controlsBar.append(searchInput, favFilterBtn, sortSelect);
  headerCard.append(topRow, controlsBar);
  shell.appendChild(headerCard);

  // Lista de músicas
  const listCard = document.createElement("section");
  listCard.className = "card";

  const listHost = document.createElement("div");
  listHost.className = "library-list";

  listCard.appendChild(listHost);
  shell.appendChild(listCard);
  container.appendChild(shell);

  function renderSongsList(data) {
    lastLoadedData = data || { songs: [], totalCount: 0, totalSizeBytes: 0 };
    const allSongs = Array.isArray(lastLoadedData.songs) ? lastLoadedData.songs : [];
    const totalCount = Number(lastLoadedData.totalCount ?? allSongs.length);
    const totalSizeBytes = Number(lastLoadedData.totalSizeBytes ?? 0);
    const favCount = allSongs.filter((s) => Boolean(s.favorite)).length;

    summaryEl.textContent = `${totalCount} música(s) pronta(s) (${favCount} favorita(s)) • Espaço ocupado no disco: ${formatBytes(totalSizeBytes)}`;
    listHost.replaceChildren();

    const visibleSongs = onlyFavorites
      ? allSongs.filter((s) => Boolean(s.favorite))
      : allSongs;

    if (visibleSongs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      if (onlyFavorites) {
        empty.textContent =
          "Nenhuma música marcada como favorita ainda. Clique na estrela (☆) ao lado de uma música para destacá-la.";
      } else if (currentQuery) {
        empty.textContent = `Nenhuma música encontrada no cache para "${currentQuery}".`;
      } else {
        empty.textContent =
          "Sua biblioteca local ainda está vazia. Clique em '+ Preparar nova música' para começar.";
      }
      listHost.appendChild(empty);
      return;
    }

    for (const song of visibleSongs) {
      const item = document.createElement("article");
      item.className = song.favorite
        ? "library-item-card library-item-card--favorite"
        : "library-item-card";

      const info = document.createElement("div");
      info.className = "library-item-info";

      const titleRow = document.createElement("div");
      titleRow.className = "library-item-title-row";

      const favBtn = createFavoriteButton(song, {
        onToggle: (nextFav) => {
          item.classList.toggle("library-item-card--favorite", nextFav);
          renderSongsList(lastLoadedData);
        },
      });

      const songTitle = document.createElement("h3");
      songTitle.className = "library-item-title";
      songTitle.textContent = song.title || song.videoId;

      titleRow.append(favBtn, songTitle);

      if (song.compatibility) {
        titleRow.appendChild(
          createCompatibilityBadge(song.compatibility, { compact: true, showReasons: false })
        );
      }

      const metaRow = document.createElement("div");
      metaRow.className = "library-item-meta muted";

      const lyrType = song.lyrics?.type || "none";
      const lyrLabel =
        lyrType === "synced"
          ? "Letra LRC"
          : lyrType === "plain"
            ? "Letra TXT"
            : "Sem letra";

      metaRow.textContent = `${song.channel || "Canal desconhecido"} • ${formatDuration(song.duration)} • ${lyrLabel} • ${formatBytes(song.sizeBytes)} • Último uso: ${formatDatePt(song.lastPlayed)}`;

      info.append(titleRow, metaRow);

      const actions = document.createElement("div");
      actions.className = "library-item-actions";

      const singBtn = document.createElement("button");
      singBtn.type = "button";
      singBtn.className = "btn btn-primary";
      singBtn.textContent = "Cantar";
      singBtn.addEventListener("click", () => {
        navigate(`/pre-jogo/${encodeURIComponent(song.videoId)}`);
      });

      const reprocessBtn = document.createElement("button");
      reprocessBtn.type = "button";
      reprocessBtn.className = "btn btn-secondary";
      reprocessBtn.textContent = "Reprocessar";
      reprocessBtn.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "Reprocessar música?",
          message: `Os arquivos atuais de "${song.title || song.videoId}" serão removidos e baixados novamente do YouTube.`,
          confirmText: "Reprocessar",
          danger: true,
        });
        if (!ok || disposed) return;

        reprocessBtn.disabled = true;
        try {
          await api.deleteSong(song.videoId);
          navigate(`/preparo/${encodeURIComponent(song.videoId)}`);
        } catch (err) {
          showBanner("error", err.message);
          reprocessBtn.disabled = false;
        }
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-danger";
      deleteBtn.textContent = "Excluir";
      deleteBtn.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "Excluir música do cache?",
          message: `Remover "${song.title || song.videoId}" liberará ${formatBytes(song.sizeBytes)} em disco. O histórico de notas será mantido.`,
          confirmText: "Excluir",
          danger: true,
        });
        if (!ok || disposed) return;

        deleteBtn.disabled = true;
        try {
          await api.deleteSong(song.videoId);
          showBanner("info", `"${song.title || song.videoId}" removida do cache.`);
          await loadSongs();
        } catch (err) {
          showBanner("error", err.message);
          deleteBtn.disabled = false;
        }
      });

      actions.append(singBtn, reprocessBtn, deleteBtn);
      item.append(info, actions);
      listHost.appendChild(item);
    }
  }

  async function loadSongs() {
    try {
      const data = await api.getSongs({ q: currentQuery, sort: currentSort });
      if (disposed) return;
      renderSongsList(data);

      // Atualiza store global quando não há filtro ativo
      if (!currentQuery) {
        const all = Array.isArray(data?.songs) ? data.songs : [];
        setState({ songs: all, songsCount: all.length });
      }
    } catch (err) {
      if (!disposed) {
        summaryEl.textContent = `Erro ao carregar biblioteca: ${err.message}`;
        showBanner("error", err.message);
      }
    }
  }

  searchInput.addEventListener("input", () => {
    currentQuery = searchInput.value.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!disposed) loadSongs();
    }, 220);
  });

  sortSelect.addEventListener("change", () => {
    currentSort = sortSelect.value;
    loadSongs();
  });

  loadSongs();

  return () => {
    disposed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}