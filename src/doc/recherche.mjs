// Trouver des adresses, sans passer par personne.
//
// La recherche web était rendue par un outil serveur d'Anthropic : chercher, c'était
// déjà sortir par chez eux. On interroge maintenant un moteur directement depuis le
// Mac — une instance SearXNG si Nicolas en fait tourner une, sinon la façade HTML de
// DuckDuckGo, qui ne demande ni clé ni compte.
//
// Ce module ne rend que des ADRESSES. Le contenu, lui, ne s'obtient que par
// `consulter_source` : c'est ce qui garde la bibliographie honnête (voir sources.mjs).
import { decoderEntites, normaliserUrl } from './web.mjs'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** Ni un moteur, ni un agrégateur : rien à citer là-dedans. */
const INUTILES = /^(duckduckgo\.com|www\.google\.|bing\.com|search\.marcia|r\.search\.yahoo|yandex\.)/i

async function texteDe(url, { signal, timeout, entete = {} }) {
  const ctrl = new AbortController()
  const minuteur = setTimeout(() => ctrl.abort(), timeout)
  const relais = () => ctrl.abort()
  signal?.addEventListener('abort', relais, { once: true })
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        ...entete,
      },
    })
    if (!r.ok) throw new Error(`${r.status} ${r.statusText || ''}`.trim())
    return await r.text()
  } finally {
    clearTimeout(minuteur)
    signal?.removeEventListener('abort', relais)
  }
}

/**
 * DuckDuckGo maquille ses liens : l'adresse vraie est dans le paramètre `uddg`.
 * On la décode à la main — `searchParams` transformerait au passage les `+` de
 * l'adresse cible en espaces, et l'adresse ne répondrait plus.
 */
function demasquer(href) {
  const brut = href.match(/[?&]uddg=([^&]+)/)?.[1]
  if (brut) {
    try { return decodeURIComponent(brut) } catch { return brut }
  }
  try { return new URL(href, 'https://duckduckgo.com').toString() } catch { return href }
}

const sansBalises = (s) => decoderEntites(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

function depouillerDuckDuckGo(html, max) {
  const out = []
  const vues = new Set()
  const re = /<a[^>]+class="[^"]*result(?:__a|-link)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,1200}?)(?=<a[^>]+class="[^"]*result(?:__a|-link)|$)/gi
  let m
  while ((m = re.exec(html)) && out.length < max) {
    const url = demasquer(decoderEntites(m[1]))
    if (!/^https?:\/\//i.test(url)) continue
    const hote = (() => { try { return new URL(url).hostname } catch { return '' } })()
    if (INUTILES.test(hote)) continue
    const cle = normaliserUrl(url)
    if (vues.has(cle)) continue
    vues.add(cle)
    const extrait = sansBalises((m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '')
    out.push({ titre: sansBalises(m[2]) || hote, url, extrait: extrait.slice(0, 320) || undefined })
  }
  return out
}

/** La version « lite » : pas de classes CSS, juste un tableau de liens. */
function depouillerLite(html, max) {
  const out = []
  const vues = new Set()
  const re = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*result-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) && out.length < max) {
    const url = demasquer(decoderEntites(m[1]))
    if (!/^https?:\/\//i.test(url)) continue
    const cle = normaliserUrl(url)
    if (vues.has(cle)) continue
    vues.add(cle)
    out.push({ titre: sansBalises(m[2]), url })
  }
  return out
}

async function viaDuckDuckGo(requete, { max, signal, timeout, langue }) {
  const q = encodeURIComponent(requete)
  const region = langue === 'anglais' ? 'us-en' : 'fr-fr'
  try {
    const html = await texteDe(`https://html.duckduckgo.com/html/?q=${q}&kl=${region}`, { signal, timeout })
    const r = depouillerDuckDuckGo(html, max)
    if (r.length) return { moteur: 'duckduckgo', resultats: r }
  } catch (err) {
    if (signal?.aborted) throw err
  }
  const html = await texteDe(`https://lite.duckduckgo.com/lite/?q=${q}&kl=${region}`, { signal, timeout })
  return { moteur: 'duckduckgo (lite)', resultats: depouillerLite(html, max) }
}

async function viaSearxng(base, requete, { max, signal, timeout, langue }) {
  const racine = String(base).replace(/\/+$/, '')
  const url = `${racine}/search?q=${encodeURIComponent(requete)}&format=json`
    + `&language=${langue === 'anglais' ? 'en' : 'fr'}&safesearch=0`
  const brut = await texteDe(url, { signal, timeout, entete: { Accept: 'application/json' } })
  const data = JSON.parse(brut)
  const resultats = (data?.results || []).slice(0, max).map((r) => ({
    titre: sansBalises(r.title || r.url),
    url: r.url,
    extrait: r.content ? sansBalises(r.content).slice(0, 320) : undefined,
  })).filter((r) => /^https?:\/\//i.test(r.url || ''))
  return { moteur: 'searxng', resultats }
}

/**
 * Cherche des adresses sur le web.
 *
 * @param {string} requete
 * @param {object} o
 * @param {number} [o.max] nombre de résultats rendus
 * @param {string} [o.searxng] adresse d'une instance SearXNG (locale ou non), prioritaire
 * @param {string} [o.langue] « français » ou « anglais » — oriente la région du moteur
 * @returns {Promise<{moteur:string,requete:string,resultats:Array<{titre:string,url:string,extrait?:string}>}>}
 */
export async function chercher(requete, { max = 8, searxng = null, langue = 'français', signal, timeout = 20000 } = {}) {
  const q = String(requete || '').trim()
  if (!q) throw new Error('Requête vide.')

  if (searxng) {
    try {
      const r = await viaSearxng(searxng, q, { max, signal, timeout, langue })
      if (r.resultats.length) return { ...r, requete: q }
    } catch (err) {
      if (signal?.aborted) throw err
      // Instance éteinte ou format JSON désactivé : on retombe sur DuckDuckGo.
    }
  }

  try {
    const r = await viaDuckDuckGo(q, { max, signal, timeout, langue })
    return { ...r, requete: q }
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(
      `Impossible d'interroger le moteur de recherche : ${err?.message || err}. `
      + "Vérifie la connexion, ou travaille hors ligne sur des sources déjà lues.",
    )
  }
}
