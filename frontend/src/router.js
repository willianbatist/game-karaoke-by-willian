/**
 * Roteador SPA baseado em hash (#/) com suporte a cleanup ao sair da rota.
 */

import { setState } from "./store.js";

const renderers = new Map();
let activeCleanup = null;

function parseHash(rawHash) {
  const cleaned = String(rawHash || "")
    .replace(/^#/, "")
    .replace(/\/+$/, "");

  const path = cleaned === "" ? "/" : cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
  const segments = path.split("/").filter(Boolean);

  if (segments.length === 0) {
    return { name: "home", params: {}, path: "/" };
  }

  if (segments[0] === "prepare" && segments[1]) {
    return {
      name: "prepare",
      params: { videoId: decodeURIComponent(segments[1]) },
      path,
    };
  }

  if (segments[0] === "play" && segments[1]) {
    return {
      name: "play",
      params: { videoId: decodeURIComponent(segments[1]) },
      path,
    };
  }

  if (segments[0] === "result" && segments[1]) {
    return {
      name: "result",
      params: { sessionId: decodeURIComponent(segments[1]) },
      path,
    };
  }

  if (segments[0] === "history" && segments.length === 1) {
    return { name: "history", params: {}, path };
  }

  if (segments[0] === "settings" && segments.length === 1) {
    return { name: "settings", params: {}, path };
  }

  return { name: "notFound", params: { path }, path };
}

function updateActiveNavLinks(routeName) {
  const links = document.querySelectorAll("[data-nav-route]");
  for (const link of links) {
    const target = link.getAttribute("data-nav-route");
    link.classList.toggle("active", target === routeName);
  }
}

export function registerRouteRenderer(routeName, renderFn) {
  renderers.set(routeName, renderFn);
}

export function navigate(hashPath) {
  const normalized = hashPath.startsWith("#") ? hashPath : `#${hashPath}`;
  if (window.location.hash === normalized) {
    renderCurrentRoute();
    return;
  }
  window.location.hash = normalized;
}

export function renderCurrentRoute() {
  const container = document.getElementById("app-view");
  if (!container) return;

  if (typeof activeCleanup === "function") {
    try {
      activeCleanup();
    } catch (err) {
      console.error("[router] Erro no cleanup da rota:", err);
    }
    activeCleanup = null;
  }

  const route = parseHash(window.location.hash);
  setState({ route });
  updateActiveNavLinks(route.name);

  const renderFn = renderers.get(route.name) || renderers.get("notFound");
  if (typeof renderFn === "function") {
    const maybeCleanup = renderFn(container, route.params);
    if (typeof maybeCleanup === "function") {
      activeCleanup = maybeCleanup;
    }
  }
}

export function initRouter() {
  if (!window.location.hash) {
    window.location.hash = "#/";
  }
  window.addEventListener("hashchange", renderCurrentRoute);
  renderCurrentRoute();
}