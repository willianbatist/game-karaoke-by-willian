/**
 * Tela de Resultados da Busca (#/busca?q=) — ARCHITECTURE.md §6.A, §10.1 e T4.5.2.
 * Exibe thumbnail, título, canal, duração e indicador de letra sincronizada disponível.
 * NÃO exibe compatibilidade aqui (exibida somente após escolher a música).
 */

import { api } from "../api.js";
import { navigate } from "../router.js";
import { getState, setState } from "../store.js";
import { extractYouTubeVideoId } from "./homeView.js";

function formatDuration(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  if (total <= 0) return "--:--";
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function renderSearchView(container, params = {}) {
  let disposed = false;
  const initialQuery = String(params.q || "").trim();

  container.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "search-shell";

  // Barra superior de busca
  const topCard = document.createElement("section");
  topCard.className = "card";

  const topRow = document.createElement("div");
  topRow.className = "section-header-row";

  const backBtn = document.createElement("button");
  backBtn.type = "button";
  backBtn.className = "btn btn-secondary";
  backBtn.textContent = "← Início";
  backBtn.addEventListener("click", () => navigate("/"));

  const heading = document.createElement("h1");
  heading.textContent = "Resultados da Busca";

  topRow.append(heading, backBtn);

  const form = document.createElement("form");
  form.className = "inline-action-form";

  const input = document.createElement("input");
  input.type = "search";
  input.className = "text-input";
  input.value = initialQuery;
  input.placeholder = "Pesquisar outra música ou colar link do YouTube...";
  input.setAttribute("aria-label", "Termo de busca no YouTube");
  input.required = true;

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn btn-primary";
  submitBtn.textContent = "Buscar";

  form.append(input, submitBtn);
  topCard.append(topRow, form);
  shell.appendChild(topCard);

  // Área de resultados
  const resultsCard = document.createElement("section");
  resultsCard.className = "card";

  const statusText = document.createElement("p");
  statusText.className = "muted";

  const listHost = document.createElement("div");
  listHost.className = "search-results-list";

  resultsCard.append(statusText, listHost);
  shell.appendChild(resultsCard);
  container.appendChild(shell);

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const nextQ = input.value.trim();
    if (!nextQ) return;

    const directId = extractYouTubeVideoId(nextQ);
    if (directId) {
      navigate(`/preparo/${encodeURIComponent(directId)}`);
      return;
    }

    navigate(`/busca?q=${encodeURIComponent(nextQ)}`);
  });

  function chooseVideo(item) {
    // Salva metadados escolhidos na store para a pré-análise em POST /api/prepare
    const cacheMap = { ...(getState().searchMetadataById || {}) };
    cacheMap[item.videoId] = {
      videoId: item.videoId,
      title: item.title || "",
      channel: item.channel || "",
      duration: Number(item.duration) || 0,
      thumbnail: item.thumbnail || "",
      hasSyncedLyrics: Boolean(item.hasSyncedLyrics),
    };
    setState({
      searchMetadataById: cacheMap,
      lastSearchQuery: input.value.trim(),
    });

    navigate(`/preparo/${encodeURIComponent(item.videoId)}`);
  }

  function renderResults(items, queryUsed) {
    listHost.replaceChildren();

    if (!Array.isArray(items) || items.length === 0) {
      statusText.textContent = `Nenhum vídeo encontrado para "${queryUsed}". Tente outro termo ou cole o link do YouTube.`;
      return;
    }

    statusText.textContent = `${items.length} resultado(s) encontrado(s) para "${queryUsed}"`;

    const cachedIds = new Set(
      (getState().songs || []).map((s) => s.videoId)
    );

    for (const item of items) {
      const row = document.createElement("article");
      row.className = "search-result-card";

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "search-thumb-wrap";

      if (item.thumbnail) {
        const img = document.createElement("img");
        img.src = item.thumbnail;
        img.alt = "";
        img.loading = "lazy";
        img.className = "search-thumb-img";
        thumbWrap.appendChild(img);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "search-thumb-placeholder";
        placeholder.textContent = "♪";
        thumbWrap.appendChild(placeholder);
      }

      const durBadge = document.createElement("span");
      durBadge.className = "search-duration-badge mono";
      durBadge.textContent = formatDuration(item.duration);
      thumbWrap.appendChild(durBadge);

      const info = document.createElement("div");
      info.className = "search-result-info";

      const titleEl = document.createElement("h3");
      titleEl.className = "search-result-title";
      titleEl.textContent = item.title || item.videoId;

      const channelEl = document.createElement("div");
      channelEl.className = "muted";
      channelEl.textContent = item.channel || "Canal desconhecido";

      const badges = document.createElement("div");
      badges.className = "search-result-badges";

      const lyrBadge = document.createElement("span");
      lyrBadge.className = item.hasSyncedLyrics ? "pill synced" : "pill";
      lyrBadge.textContent = item.hasSyncedLyrics
        ? "Letra sincronizada disponível"
        : "Letra sincronizada não confirmada";
      badges.appendChild(lyrBadge);

      if (cachedIds.has(item.videoId)) {
        const cachedPill = document.createElement("span");
        cachedPill.className = "pill synced";
        cachedPill.textContent = "Já no cache";
        badges.appendChild(cachedPill);
      }

      info.append(titleEl, channelEl, badges);

      const actionCol = document.createElement("div");
      actionCol.className = "search-result-actions";

      const selectBtn = document.createElement("button");
      selectBtn.type = "button";
      selectBtn.className = "btn btn-primary";
      selectBtn.textContent = cachedIds.has(item.videoId) ? "Abrir pré-jogo" : "Preparar";
      selectBtn.addEventListener("click", () => chooseVideo(item));

      actionCol.appendChild(selectBtn);
      row.append(thumbWrap, info, actionCol);
      listHost.appendChild(row);
    }
  }

  async function runSearch(query) {
    if (!query) {
      statusText.textContent = "Digite o nome de uma música ou artista acima para buscar.";
      return;
    }

    submitBtn.disabled = true;
    statusText.textContent = `Buscando "${query}" no YouTube...`;
    listHost.replaceChildren();

    try {
      const data = await api.searchSongs(query);
      if (disposed) return;
      renderResults(data?.results || [], query);
    } catch (err) {
      if (!disposed) {
        statusText.textContent = `Não foi possível concluir a busca: ${err.message}`;
      }
    } finally {
      if (!disposed) {
        submitBtn.disabled = false;
      }
    }
  }

  runSearch(initialQuery);

  return () => {
    disposed = true;
  };
}