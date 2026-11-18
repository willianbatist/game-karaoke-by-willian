/**
 * Bootstrap da aplicação frontend (T4.5).
 */

import { api } from "./api.js";
import { getLocale, initI18n, setLocale, t } from "./i18n.js";
import { playerStore } from "./players/playerStore.js";
import { initRouter, navigate, registerRouteRenderer, renderCurrentRoute } from "./router.js";
import { getState, setState, setTheme, showBanner, subscribe } from "./store.js";
import { initBanner } from "./ui/banner.js";
import { initConfirmModal } from "./ui/confirmModal.js";
import { renderHomeView } from "./views/homeView.js";
import { renderPlayView } from "./views/playView.js";
import { renderPregameView } from "./views/pregameView.js";
import { renderPrepareView } from "./views/prepareView.js";
import { renderResultView } from "./views/resultView.js";
import { renderSearchView } from "./views/searchView.js";
import { renderSettingsView } from "./views/settingsView.js";

function renderStaticChrome() {
  const brandTitle = document.getElementById("brand-title");
  if (brandTitle) brandTitle.textContent = t("app.title");

  const navHome = document.getElementById("nav-home");
  const navLibrary = document.getElementById("nav-library");
  const navHistory = document.getElementById("nav-history");
  const navSettings = document.getElementById("nav-settings");
  if (navHome) navHome.textContent = t("nav.home");
  if (navLibrary) navLibrary.textContent = "Biblioteca";
  if (navHistory) navHistory.textContent = t("nav.history");
  if (navSettings) navSettings.textContent = t("nav.settings");

  const themeSelect = document.getElementById("theme-select");
  if (themeSelect) {
    themeSelect.setAttribute("aria-label", t("theme.label"));
    const darkOpt = themeSelect.querySelector('option[value="dark"]');
    const lightOpt = themeSelect.querySelector('option[value="light"]');
    if (darkOpt) darkOpt.textContent = t("theme.dark");
    if (lightOpt) lightOpt.textContent = t("theme.light");
  }

  const localeSelect = document.getElementById("locale-select");
  if (localeSelect) {
    localeSelect.setAttribute("aria-label", t("lang.label"));
  }

  renderHealthBadge(getState().health);
}

function renderHealthBadge(health) {
  const badge = document.getElementById("health-badge");
  if (!badge) return;

  if (!health) {
    badge.className = "health-badge";
    badge.textContent = t("health.checking");
    return;
  }

  if (health.offline) {
    badge.className = "health-badge degraded";
    badge.textContent = t("health.offline");
    return;
  }

  if (health.status === "ok") {
    const device = String(health.worker?.accelerator_detected || "cpu").toUpperCase();
    badge.className = "health-badge ok";
    badge.textContent = t("health.ok", { device });
  } else {
    badge.className = "health-badge degraded";
    badge.textContent = t("health.degraded");
  }
}

function registerViews() {
  registerRouteRenderer("home", renderHomeView);
  registerRouteRenderer("search", renderSearchView);
  registerRouteRenderer("prepare", renderPrepareView);
  registerRouteRenderer("pregame", renderPregameView);
  registerRouteRenderer("play", renderPlayView);
  registerRouteRenderer("result", renderResultView);
  registerRouteRenderer("settings", renderSettingsView);

  registerRouteRenderer("library", (container) => {
    container.replaceChildren();
    const card = document.createElement("section");
    card.className = "card";
    const h2 = document.createElement("h2");
    h2.textContent = "Biblioteca";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "A gestão completa da biblioteca será finalizada na etapa T4.6.";
    card.append(h2, p);
    container.appendChild(card);
  });

  registerRouteRenderer("history", (container) => {
    container.replaceChildren();
    const card = document.createElement("section");
    card.className = "card";
    const h2 = document.createElement("h2");
    h2.textContent = t("routes.historyTitle");
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = t("routes.historyDesc");
    card.append(h2, p);
    container.appendChild(card);
  });

  registerRouteRenderer("notFound", (container) => {
    container.replaceChildren();
    const card = document.createElement("section");
    card.className = "card";
    const h2 = document.createElement("h2");
    h2.textContent = t("routes.notFoundTitle");
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = t("routes.notFoundDesc");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-primary";
    btn.textContent = t("routes.backHome");
    btn.addEventListener("click", () => navigate("/"));
    card.append(h2, p, btn);
    container.appendChild(card);
  });
}

async function refreshSongsList() {
  const songsData = await api.getSongs();
  const songs = Array.isArray(songsData?.songs) ? songsData.songs : [];
  setState({ songs, songsCount: songs.length });
}

async function loadInitialBackendData() {
  try {
    const [config] = await Promise.all([
      api.getConfig(),
      refreshSongsList(),
      playerStore.loadPlayers().catch(() => []),
    ]);
    setState({ config });
  } catch (err) {
    showBanner("error", err.message);
  }

  try {
    const health = await api.getHealth();
    setState({ health });
    renderHealthBadge(health);
  } catch {
    const offlineHealth = { offline: true };
    setState({ health: offlineHealth });
    renderHealthBadge(offlineHealth);
  }
}

async function bootstrap() {
  const activeLocale = await initI18n();
  setState({ locale: activeLocale });

  initBanner();
  initConfirmModal();

  const themeSelect = document.getElementById("theme-select");
  if (themeSelect) {
    themeSelect.value = getState().theme;
    themeSelect.addEventListener("change", (evt) => {
      setTheme(evt.target.value);
    });
  }

  const localeSelect = document.getElementById("locale-select");
  if (localeSelect) {
    localeSelect.value = getLocale();
    localeSelect.addEventListener("change", async (evt) => {
      const nextLocale = await setLocale(evt.target.value);
      setState({ locale: nextLocale });
      renderStaticChrome();
      renderCurrentRoute();
    });
  }

  subscribe((state) => {
    renderHealthBadge(state.health);
  });

  window.addEventListener("hashchange", () => {
    if (getState().route.name === "home") {
      refreshSongsList().catch(() => {});
    }
  });

  renderStaticChrome();
  registerViews();
  initRouter();

  await loadInitialBackendData();
}

bootstrap();