/**
 * Tela Inicial (#/) — FRONTEND_ARCHITECTURE.md §3.2, §4.2, §5.3 e T4.5.1:
 * - Cartão ativo "Modo Karaokê" e cartão desabilitado "Modo Campeonato — Em breve"
 * - Seletor/criação rápida de jogador (ou Convidado) via playerStore
 * - Busca por nome da música/artista ou link/ID do YouTube
 * - Atalhos para Biblioteca, Histórico e Configurações + aviso de primeira execução
 */

import { championshipMode } from "../game/modes/championship.js";
import { playerStore } from "../players/playerStore.js";
import { navigate } from "../router.js";
import { getState, showBanner, subscribe } from "../store.js";

const FIRST_RUN_KEY = "karaoke.firstRunDone.v1";

function isFirstRunPending() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return false;
    return window.localStorage.getItem(FIRST_RUN_KEY) !== "true";
  } catch {
    return false;
  }
}

function markFirstRunDone() {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(FIRST_RUN_KEY, "true");
    }
  } catch {
    // Ignora falha de storage
  }
}

export function extractYouTubeVideoId(rawInput) {
  const value = String(rawInput || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace(/^\//, "").slice(0, 11);
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (url.hostname.endsWith("youtube.com")) {
      const vParam = url.searchParams.get("v");
      if (vParam && /^[A-Za-z0-9_-]{11}$/.test(vParam)) {
        return vParam;
      }
      const match = /^\/(?:embed|shorts|v)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
      if (match) return match[1];
    }
  } catch {
    return null;
  }

  return null;
}

function formatDuration(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function renderHomeView(container) {
  container.replaceChildren();

  const shell = document.createElement("div");
  shell.className = "home-shell";

  // 1. Assistente de primeira execução (FRONTEND_ARCHITECTURE.md §5.3)
  if (isFirstRunPending()) {
    const onboardingCard = document.createElement("section");
    onboardingCard.className = "card onboarding-card";

    const obTextWrap = document.createElement("div");
    const obTitle = document.createElement("h2");
    obTitle.textContent = "Bem-vindo ao Karaokê Local!";
    const obDesc = document.createElement("p");
    obDesc.className = "muted";
    obDesc.textContent =
      "Antes de começar a cantar, recomendamos selecionar seu microfone e calibrar a latência para uma pontuação mais precisa.";
    obTextWrap.append(obTitle, obDesc);

    const obActions = document.createElement("div");
    obActions.className = "onboarding-actions";

    const configNowBtn = document.createElement("button");
    configNowBtn.type = "button";
    configNowBtn.className = "btn btn-primary";
    configNowBtn.textContent = "Configurar microfone agora";
    configNowBtn.addEventListener("click", () => {
      markFirstRunDone();
      navigate("/configuracoes");
    });

    const skipObBtn = document.createElement("button");
    skipObBtn.type = "button";
    skipObBtn.className = "btn btn-secondary";
    skipObBtn.textContent = "Continuar depois";
    skipObBtn.addEventListener("click", () => {
      markFirstRunDone();
      onboardingCard.remove();
    });

    obActions.append(configNowBtn, skipObBtn);
    onboardingCard.append(obTextWrap, obActions);
    shell.appendChild(onboardingCard);
  }

  // 2. Cartões de Modo de Jogo (Modo Karaokê ativo vs Campeonato Em breve)
  const modesGrid = document.createElement("section");
  modesGrid.className = "modes-grid";
  modesGrid.setAttribute("aria-label", "Modos de jogo");

  const standardCard = document.createElement("article");
  standardCard.className = "mode-card mode-card-active";

  const stdTop = document.createElement("div");
  stdTop.className = "mode-card-header";
  const stdTitle = document.createElement("h2");
  stdTitle.textContent = "Modo Karaokê";
  const stdTag = document.createElement("span");
  stdTag.className = "pill synced";
  stdTag.textContent = "Disponível";
  stdTop.append(stdTitle, stdTag);

  const stdDesc = document.createElement("p");
  stdDesc.className = "muted";
  stdDesc.textContent =
    "Escolha qualquer música do YouTube ou do seu cache local, cante com acompanhamento de tom e registre sua nota no histórico.";

  standardCard.append(stdTop, stdDesc);

  const champCard = document.createElement("article");
  champCard.className = "mode-card mode-card-disabled";
  champCard.setAttribute("aria-disabled", "true");

  const champTop = document.createElement("div");
  champTop.className = "mode-card-header";
  const champTitle = document.createElement("h2");
  champTitle.textContent = "Modo Campeonato";
  const champTag = document.createElement("span");
  champTag.className = "pill";
  champTag.dataset.modeId = championshipMode.id;
  champTag.textContent = "Em breve";
  champTop.append(champTitle, champTag);

  const champDesc = document.createElement("p");
  champDesc.className = "muted";
  champDesc.textContent =
    "Disputa entre vários jogadores por rodadas com placar acumulado e chaveamento local.";

  champCard.append(champTop, champDesc);
  modesGrid.append(standardCard, champCard);
  shell.appendChild(modesGrid);

  // 3. Seletor e criação rápida de jogador ("Quem vai cantar?")
  const playerCard = document.createElement("section");
  playerCard.className = "card";

  const playerHeader = document.createElement("div");
  playerHeader.className = "section-header-row";
  const playerHeading = document.createElement("h2");
  playerHeading.textContent = "Quem vai cantar?";
  const activePlayerBadge = document.createElement("span");
  activePlayerBadge.className = "pill synced";
  playerHeader.append(playerHeading, activePlayerBadge);

  const playerChipsRow = document.createElement("div");
  playerChipsRow.className = "player-chips-row";

  const quickCreateForm = document.createElement("form");
  quickCreateForm.className = "inline-action-form";

  const newPlayerInput = document.createElement("input");
  newPlayerInput.type = "text";
  newPlayerInput.className = "text-input";
  newPlayerInput.maxLength = 30;
  newPlayerInput.placeholder = "Novo jogador (ex.: Ana, Willian 🎤)...";
  newPlayerInput.setAttribute("aria-label", "Nome do novo jogador");

  const addPlayerBtn = document.createElement("button");
  addPlayerBtn.type = "submit";
  addPlayerBtn.className = "btn btn-secondary";
  addPlayerBtn.textContent = "+ Criar jogador";

  quickCreateForm.append(newPlayerInput, addPlayerBtn);

  function renderPlayerChips() {
    const active = playerStore.getActivePlayer();
    const list = playerStore.getPlayers();
    activePlayerBadge.textContent = `Cantando agora: ${active.name}`;

    playerChipsRow.replaceChildren();

    const guestBtn = document.createElement("button");
    guestBtn.type = "button";
    guestBtn.className = active.isGuest ? "player-chip active" : "player-chip";
    guestBtn.textContent = "Convidado";
    guestBtn.addEventListener("click", () => {
      playerStore.selectPlayer("guest");
      renderPlayerChips();
    });
    playerChipsRow.appendChild(guestBtn);

    for (const p of list) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = !active.isGuest && active.id === p.id ? "player-chip active" : "player-chip";
      btn.textContent = p.name;
      btn.addEventListener("click", () => {
        playerStore.selectPlayer(p.id);
        renderPlayerChips();
      });
      playerChipsRow.appendChild(btn);
    }
  }

  quickCreateForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const raw = newPlayerInput.value;
    if (!raw.trim()) return;
    addPlayerBtn.disabled = true;
    try {
      await playerStore.createPlayer(raw);
      newPlayerInput.value = "";
      renderPlayerChips();
    } catch (err) {
      showBanner("warning", err.message);
    } finally {
      addPlayerBtn.disabled = false;
    }
  });

  renderPlayerChips();
  playerCard.append(playerHeader, playerChipsRow, quickCreateForm);
  shell.appendChild(playerCard);

  // 4. Barra de Busca de Música ou Link direto do YouTube
  const searchCard = document.createElement("section");
  searchCard.className = "card";

  const searchTitle = document.createElement("h2");
  searchTitle.textContent = "Escolher uma música";

  const searchSubtitle = document.createElement("p");
  searchSubtitle.className = "muted";
  searchSubtitle.textContent =
    "Pesquise pelo nome da música ou artista no YouTube, ou cole diretamente o link/ID do vídeo.";

  const searchForm = document.createElement("form");
  searchForm.className = "inline-action-form";

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "text-input";
  searchInput.placeholder = "Ex.: Evidências Chitãozinho e Xororó ou link do YouTube...";
  searchInput.setAttribute("aria-label", "Buscar música ou colar link do YouTube");
  searchInput.required = true;

  const searchBtn = document.createElement("button");
  searchBtn.type = "submit";
  searchBtn.className = "btn btn-primary";
  searchBtn.textContent = "Buscar música";

  searchForm.append(searchInput, searchBtn);

  searchForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const rawQuery = searchInput.value.trim();
    if (!rawQuery) return;

    const directId = extractYouTubeVideoId(rawQuery);
    if (directId) {
      navigate(`/preparo/${encodeURIComponent(directId)}`);
      return;
    }

    navigate(`/busca?q=${encodeURIComponent(rawQuery)}`);
  });

  // Atalhos rápidos para Biblioteca, Histórico e Configurações
  const shortcutsRow = document.createElement("div");
  shortcutsRow.className = "home-shortcuts-row";

  const libBtn = document.createElement("button");
  libBtn.type = "button";
  libBtn.className = "btn btn-secondary";
  libBtn.textContent = "Abrir Biblioteca";
  libBtn.addEventListener("click", () => navigate("/biblioteca"));

  const histBtn = document.createElement("button");
  histBtn.type = "button";
  histBtn.className = "btn btn-secondary";
  histBtn.textContent = "Histórico e Rankings";
  histBtn.addEventListener("click", () => navigate("/historico"));

  const cfgBtn = document.createElement("button");
  cfgBtn.type = "button";
  cfgBtn.className = "btn btn-secondary";
  cfgBtn.textContent = "Configurações de Áudio";
  cfgBtn.addEventListener("click", () => navigate("/configuracoes"));

  shortcutsRow.append(libBtn, histBtn, cfgBtn);
  searchCard.append(searchTitle, searchSubtitle, searchForm, shortcutsRow);
  shell.appendChild(searchCard);

  // 5. Prévia rápida das músicas prontas no cache local
  const cachedSection = document.createElement("section");
  cachedSection.className = "card";

  const cachedHeader = document.createElement("div");
  cachedHeader.className = "section-header-row";
  const cachedHeading = document.createElement("h2");
  const seeAllLibBtn = document.createElement("button");
  seeAllLibBtn.type = "button";
  seeAllLibBtn.className = "btn btn-secondary";
  seeAllLibBtn.textContent = "Gerenciar biblioteca";
  seeAllLibBtn.addEventListener("click", () => navigate("/biblioteca"));
  cachedHeader.append(cachedHeading, seeAllLibBtn);

  const cachedGridHost = document.createElement("div");

  function renderCachedSongs() {
    const songs = Array.isArray(getState().songs) ? getState().songs : [];
    cachedHeading.textContent = `Prontas para cantar agora (${songs.length})`;
    cachedGridHost.replaceChildren();

    if (songs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent =
        "Nenhuma música no cache local ainda. Pesquise uma música acima para preparar!";
      cachedGridHost.appendChild(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "song-grid";

    for (const song of songs.slice(0, 6)) {
      const card = document.createElement("article");
      card.className = "song-card";

      const info = document.createElement("div");
      const title = document.createElement("h3");
      title.className = "song-card-title";
      title.textContent = song.title || song.videoId;

      const meta = document.createElement("div");
      meta.className = "song-card-meta";

      const chSpan = document.createElement("span");
      chSpan.textContent = song.channel || "";

      const durSpan = document.createElement("span");
      durSpan.textContent = `• ${formatDuration(song.duration)}`;

      const lyrType = song.lyrics?.type || "none";
      const lyrPill = document.createElement("span");
      lyrPill.className = lyrType === "synced" ? "pill synced" : "pill";
      lyrPill.textContent =
        lyrType === "synced"
          ? "Letra sincronizada"
          : lyrType === "plain"
            ? "Letra sem tempo"
            : "Sem letra";

      meta.append(chSpan, durSpan, lyrPill);
      info.append(title, meta);

      const actions = document.createElement("div");
      actions.className = "song-card-actions";

      const singBtn = document.createElement("button");
      singBtn.type = "button";
      singBtn.className = "btn btn-primary";
      singBtn.textContent = "Cantar";
      singBtn.addEventListener("click", () => {
        navigate(`/pre-jogo/${encodeURIComponent(song.videoId)}`);
      });

      actions.appendChild(singBtn);
      card.append(info, actions);
      grid.appendChild(card);
    }

    cachedGridHost.appendChild(grid);
  }

  renderCachedSongs();
  cachedSection.append(cachedHeader, cachedGridHost);
  shell.appendChild(cachedSection);

  container.appendChild(shell);

  const unsubscribe = subscribe(() => {
    renderPlayerChips();
    renderCachedSongs();
  });

  return () => {
    unsubscribe();
  };
}