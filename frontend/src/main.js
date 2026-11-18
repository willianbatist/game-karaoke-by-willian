/**
 * Bootstrap da aplicação frontend (T2.2).
 */

import { api } from "./api.js";
import { getLocale, initI18n, setLocale, t } from "./i18n.js";
import { initRouter, navigate, registerRouteRenderer, renderCurrentRoute } from "./router.js";
import { getState, setState, setTheme, showBanner, subscribe } from "./store.js";
import { initBanner } from "./ui/banner.js";
import { initConfirmModal } from "./ui/confirmModal.js";
import { renderPlayView } from "./views/playView.js";
import { renderPrepareView } from "./views/prepareView.js";
import { renderResultView } from "./views/resultView.js";
import { renderSettingsView } from "./views/settingsView.js";

function extractYouTubeVideoId(rawInput) {
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

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderStaticChrome() {
  const brandTitle = document.getElementById("brand-title");
  if (brandTitle) brandTitle.textContent = t("app.title");

  const navHome = document.getElementById("nav-home");
  const navHistory = document.getElementById("nav-history");
  const navSettings = document.getElementById("nav-settings");
  if (navHome) navHome.textContent = t("nav.home");
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
  registerRouteRenderer("home", (container) => {
    const songs = getState().songs || [];

    const cardsHtml =
      songs.length === 0
        ? `<p class="muted">${t("home.noCachedSongs")}</p>`
        : `<div class="song-grid">
            ${songs
              .map((song) => {
                const lyrType = song.lyrics?.type || "none";
                const pillLabel =
                  lyrType === "synced"
                    ? t("home.lyricsSynced")
                    : lyrType === "plain"
                      ? t("home.lyricsPlain")
                      : t("home.lyricsNone");
                const pillClass = lyrType === "synced" ? "pill synced" : "pill";

                return `
                  <article class="song-card">
                    <div>
                      <h3 class="song-card-title">${escapeHtml(song.title)}</h3>
                      <div class="song-card-meta">
                        <span>${escapeHtml(song.channel)}</span>
                        <span>• ${formatDuration(song.duration)}</span>
                        <span class="${pillClass}">${pillLabel}</span>
                      </div>
                    </div>
                    <div style="display: flex; justify-content: flex-end;">
                      <button
                        type="button"
                        class="btn btn-primary"
                        data-sing-id="${escapeHtml(song.videoId)}"
                      >
                        ${t("home.singBtn")}
                      </button>
                    </div>
                  </article>
                `;
              })
              .join("")}
          </div>`;

    container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 1.5rem;">
        <section class="card">
          <h1>${t("home.heading")}</h1>
          <p class="muted">${t("home.subtitle")}</p>
          <form id="home-prepare-form" class="prepare-form">
            <input
              type="text"
              id="home-video-input"
              class="text-input"
              placeholder="${escapeHtml(t("home.inputPlaceholder"))}"
              required
            />
            <button type="submit" class="btn btn-primary">
              ${t("home.prepareBtn")}
            </button>
          </form>
        </section>

        <section class="card">
          <h2>${t("home.cachedHeading", { count: songs.length })}</h2>
          ${cardsHtml}
        </section>
      </div>
    `;

    container.querySelector("#home-prepare-form")?.addEventListener("submit", (evt) => {
      evt.preventDefault();
      const input = container.querySelector("#home-video-input");
      const videoId = extractYouTubeVideoId(input?.value);
      if (!videoId) {
        showBanner("warning", t("home.invalidVideoId"));
        return;
      }
      navigate(`/prepare/${encodeURIComponent(videoId)}`);
    });

    for (const btn of container.querySelectorAll("[data-sing-id]")) {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-sing-id");
        if (id) navigate(`/play/${encodeURIComponent(id)}`);
      });
    }
  });

  registerRouteRenderer("prepare", renderPrepareView);
  registerRouteRenderer("play", renderPlayView);
  registerRouteRenderer("result", renderResultView);
  registerRouteRenderer("settings", renderSettingsView);

  registerRouteRenderer("result", (container, params) => {
    container.innerHTML = `
      <section class="card">
        <h2>${t("routes.resultTitle", { sessionId: params.sessionId })}</h2>
        <p class="muted">${t("routes.resultDesc")}</p>
        <button type="button" class="btn btn-secondary" id="btn-back-home">${t("routes.backHome")}</button>
      </section>
    `;
    container.querySelector("#btn-back-home")?.addEventListener("click", () => navigate("/"));
  });

  registerRouteRenderer("history", (container) => {
    container.innerHTML = `
      <section class="card">
        <h2>${t("routes.historyTitle")}</h2>
        <p class="muted">${t("routes.historyDesc")}</p>
      </section>
    `;
  });

  registerRouteRenderer("notFound", (container) => {
    container.innerHTML = `
      <section class="card">
        <h2>${t("routes.notFoundTitle")}</h2>
        <p class="muted">${t("routes.notFoundDesc")}</p>
        <button type="button" class="btn btn-primary" id="btn-back-home">${t("routes.backHome")}</button>
      </section>
    `;
    container.querySelector("#btn-back-home")?.addEventListener("click", () => navigate("/"));
  });
}

async function refreshSongsList() {
  const songsData = await api.getSongs();
  const songs = Array.isArray(songsData?.songs) ? songsData.songs : [];
  setState({ songs, songsCount: songs.length });
  if (getState().route.name === "home") {
    renderCurrentRoute();
  }
}

async function loadInitialBackendData() {
  try {
    const [config] = await Promise.all([api.getConfig(), refreshSongsList()]);
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