/**
 * Componente visual de selo de compatibilidade (FRONTEND_ARCHITECTURE.md §5.3, §10 e T4.5.1).
 * Renderiza exclusivamente via nós DOM e textContent.
 */

const LEVEL_META = Object.freeze({
  excellent: {
    label: "Compatibilidade Excelente",
    shortLabel: "Excelente",
    icon: "★",
  },
  good: {
    label: "Compatibilidade Boa",
    shortLabel: "Boa",
    icon: "●",
  },
  regular: {
    label: "Compatibilidade Regular",
    shortLabel: "Regular",
    icon: "◐",
  },
  low: {
    label: "Compatibilidade Baixa",
    shortLabel: "Baixa",
    icon: "▲",
  },
  incompatible: {
    label: "Incompatível com Avaliação Vocal",
    shortLabel: "Incompatível",
    icon: "✕",
  },
});

export function getCompatibilityLevelMeta(level) {
  return LEVEL_META[level] || LEVEL_META.regular;
}

/**
 * Cria um cartão ou selo compacto de compatibilidade.
 * @param {object} compatibility - Objeto `{ level, score, reasons, provisional }`
 * @param {object} [options] - `{ compact?: boolean, showReasons?: boolean }`
 */
export function createCompatibilityBadge(
  compatibility,
  { compact = false, showReasons = true } = {}
) {
  const level = compatibility?.level || "regular";
  const meta = getCompatibilityLevelMeta(level);
  const provisional = Boolean(compatibility?.provisional);
  const reasons = Array.isArray(compatibility?.reasons) ? compatibility.reasons : [];
  const scoreNum = Number(compatibility?.score);

  if (compact) {
    const badge = document.createElement("span");
    badge.className = `compat-pill compat-${level}`;
    badge.textContent = provisional
      ? `${meta.icon} ${meta.shortLabel} (prévia)`
      : `${meta.icon} ${meta.shortLabel}`;
    if (reasons.length > 0) {
      badge.title = reasons.join(" • ");
    }
    return badge;
  }

  const card = document.createElement("div");
  card.className = `compat-card compat-${level}`;
  card.setAttribute("role", "status");

  const header = document.createElement("div");
  header.className = "compat-card-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "compat-card-title-wrap";

  const iconEl = document.createElement("span");
  iconEl.className = "compat-card-icon";
  iconEl.setAttribute("aria-hidden", "true");
  iconEl.textContent = meta.icon;

  const titleEl = document.createElement("strong");
  titleEl.className = "compat-card-title";
  titleEl.textContent = meta.label;

  titleWrap.append(iconEl, titleEl);

  if (provisional) {
    const provTag = document.createElement("span");
    provTag.className = "compat-provisional-tag";
    provTag.textContent = "Análise prévia";
    titleWrap.appendChild(provTag);
  }

  header.appendChild(titleWrap);

  if (Number.isFinite(scoreNum)) {
    const scoreTag = document.createElement("span");
    scoreTag.className = "compat-score-tag mono";
    scoreTag.textContent = `${Math.round(scoreNum * 100)}%`;
    header.appendChild(scoreTag);
  }

  card.appendChild(header);

  if (showReasons) {
    if (reasons.length > 0) {
      const list = document.createElement("ul");
      list.className = "compat-reasons-list";
      for (const reason of reasons) {
        const li = document.createElement("li");
        li.textContent = String(reason);
        list.appendChild(li);
      }
      card.appendChild(list);
    } else {
      const okNote = document.createElement("p");
      okNote.className = "compat-ok-note";
      okNote.textContent = provisional
        ? "Os metadados iniciais indicam boas condições para karaokê."
        : "Voz principal nítida e boa base para pontuação vocal.";
      card.appendChild(okNote);
    }
  }

  return card;
}