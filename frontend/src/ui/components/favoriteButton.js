/**
 * Botão global de música favorita (estrela ★ / ☆) — DOM puro sem innerHTML.
 * Persiste via PATCH /api/songs/:videoId ({ favorite: boolean }) e sincroniza o store global.
 */

import { api } from "../../api.js";
import { getState, setState, showBanner } from "../../store.js";

export function createFavoriteButton(song, { onToggle = null } = {}) {
  let isFavorite = Boolean(song?.favorite);
  let pending = false;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "favorite-star-btn";

  function syncVisual() {
    btn.classList.toggle("is-favorite", isFavorite);
    btn.setAttribute("aria-pressed", isFavorite ? "true" : "false");
    btn.setAttribute(
      "aria-label",
      isFavorite ? "Remover dos favoritos" : "Marcar como favorita"
    );
    btn.title = isFavorite ? "Remover dos favoritos" : "Marcar como favorita";
    btn.textContent = isFavorite ? "★" : "☆";
  }

  function updateGlobalStore(videoId, nextFavorite) {
    const currentSongs = Array.isArray(getState().songs) ? getState().songs : [];
    if (currentSongs.length === 0) return;

    const updated = currentSongs.map((item) =>
      item.videoId === videoId ? { ...item, favorite: nextFavorite } : item
    );
    setState({ songs: updated });
  }

  syncVisual();

  btn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (pending || !song?.videoId) return;

    const previous = isFavorite;
    const next = !previous;

    // Atualização otimista imediata
    isFavorite = next;
    song.favorite = next;
    syncVisual();
    updateGlobalStore(song.videoId, next);
    if (typeof onToggle === "function") {
      onToggle(next);
    }

    pending = true;
    try {
      await api.patchSong(song.videoId, { favorite: next });
    } catch (err) {
      // Reverte estado em caso de erro de rede/servidor
      isFavorite = previous;
      song.favorite = previous;
      syncVisual();
      updateGlobalStore(song.videoId, previous);
      if (typeof onToggle === "function") {
        onToggle(previous);
      }
      showBanner("warning", `Não foi possível atualizar favorita: ${err.message}`);
    } finally {
      pending = false;
    }
  });

  return btn;
}