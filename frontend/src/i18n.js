/**
 * Gerenciador de internacionalização (i18n) sem dependências externas.
 */

const SUPPORTED_LOCALES = ["pt-BR", "en-US"];
const STORAGE_KEY = "karaoke.locale";
const dictionaries = new Map();

let currentLocale = "pt-BR";

async function loadDictionary(locale) {
  if (dictionaries.has(locale)) {
    return dictionaries.get(locale);
  }
  const res = await fetch(`/i18n/${locale}.json`);
  if (!res.ok) {
    throw new Error(`Falha ao carregar dicionário ${locale}`);
  }
  const data = await res.json();
  dictionaries.set(locale, data);
  return data;
}

function resolveKey(obj, keyPath) {
  return keyPath.split(".").reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : null), obj);
}

/**
 * Inicializa o sistema de idiomas carregando pt-BR (fallback) e o idioma salvo.
 */
export async function initI18n() {
  const saved = localStorage.getItem(STORAGE_KEY);
  const initial = SUPPORTED_LOCALES.includes(saved) ? saved : "pt-BR";

  await loadDictionary("pt-BR");
  if (initial !== "pt-BR") {
    await loadDictionary(initial);
  }

  currentLocale = initial;
  document.documentElement.lang = currentLocale;
  return currentLocale;
}

/**
 * Altera o idioma ativo e persiste no localStorage.
 */
export async function setLocale(locale) {
  const target = SUPPORTED_LOCALES.includes(locale) ? locale : "pt-BR";
  await loadDictionary(target);
  currentLocale = target;
  localStorage.setItem(STORAGE_KEY, target);
  document.documentElement.lang = target;
  return target;
}

export function getLocale() {
  return currentLocale;
}

/**
 * Traduz uma chave (ex.: "home.cachedCount") substituindo parâmetros `{chave}`.
 */
export function t(key, vars = {}) {
  const activeDict = dictionaries.get(currentLocale) || {};
  const fallbackDict = dictionaries.get("pt-BR") || {};

  let template = resolveKey(activeDict, key) ?? resolveKey(fallbackDict, key) ?? key;

  for (const [varName, value] of Object.entries(vars)) {
    template = template.replaceAll(`{${varName}}`, String(value));
  }
  return template;
}