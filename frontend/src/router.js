/**
 * Roteador SPA baseado em hash (#/) com suporte a query string (?q=) e cleanup ao sair da rota
 * (FRONTEND_ARCHITECTURE.md §5.1).
 */

import { setState } from "./store.js";

const renderers = new Map();
let activeCleanup = null;

export function parseHash(rawHash) {
  const withoutHash = String(rawHash || "").replace(/^#/, "");
  const qIndex = withoutHash.indexOf("?");
  const rawPath = qIndex >= 0 ? withoutHash.slice(0, qIndex) : withoutHash;
  const rawQuery = qIndex >= 0 ? withoutHash.slice(qIndex + 1) : "";

  const cleanedPath = rawPath.replace(/\/+$/, "");
  const path =
    cleanedPath === "" ? "/" : cleanedPath.startsWith("/") ? cleanedPath : `/${cleanedPath}`;
  const segments = path.split("/").filter(Boolean);

  const queryParams = {};
  if (rawQuery) {
    const searchParams = new URLSearchParams(rawQuery);
    for (const [k, v] of searchParams.entries()) {
      queryParams[k] = v;
    }
  }

  if (segments.length === 0) {
    return { name: "home", params: queryParams, path };
  }

  if ((segments[0] === "busca" || segments[0] === "search") && segments.length === 1) {
    return { name: "search", params: queryParams, path };
  }

  if ((segments[0] === "preparo" || segments[0] === "prepare") && segments[1]) {
    return {
      name: "prepare",
      params: { ...queryParams, videoId: decodeURIComponent(segments[1]) },
      path,
    };
  }

  if ((segments[0] === "pre-jogo" || segments[0] === "pregame") && segments[1]) {
    return {
      name: "pregame",
      params: { ...queryParams, videoId: decodeURIComponent(segments[1]) },
      path,
    };
  }

  if ((segments[0] === "jogo" || segments[0] === "play") && segments[1]) {
    return {
      name: "play",
      params: { ...queryParams, videoId: decodeURIComponent(segments[1]) },
      path,
    };
  }

  if ((segments[0] === "resultado" || segments[0] === "result") && segments[1]) {
    return {
      name: "result",
      params: { ...queryParams, sessionId: decodeURIComponent(segments[1]) },
      path,
    };
  }

  if ((segments[0] === "biblioteca" || segments[0] === "library") && segments.length === 1) {
    return { name: "library", params: queryParams, path };
  }

  if ((segments[0] === "preparando" || segments[0] === "preparing") && segments.length === 1) {
    return { name: "preparing", params: queryParams, path };
  }

  if ((segments[0] === "historico" || segments[0] === "history") && segments.length === 1) {
    return { name: "history", params: queryParams, path };
  }

  if ((segments[0] === "configuracoes" || segments[0] === "settings") && segments.length === 1) {
    return { name: "settings", params: queryParams, path };
  }

  return { name: "notFound", params: { ...queryParams, path }, path };
}

function updateActiveNavLinks(routeName) {
  const effectiveRoute = routeName === "prepare" ? "preparing" : routeName;
  const links = document.querySelectorAll("[data-nav-route]");
  for (const link of links) {
    const target = link.getAttribute("data-nav-route");
    link.classList.toggle("active", target === effectiveRoute);
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