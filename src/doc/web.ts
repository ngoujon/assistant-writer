// Récupération et mise à plat d'une page web. Objectif : rendre au modèle le texte
// qu'un lecteur verrait, sans menus ni scripts, avec de quoi la citer honnêtement
// (titre, éditeur, auteur, date de publication).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { P } from './paths.ts'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** Une page récupérée, prête à être inscrite au registre. */
export interface Page {
  url: string
  url_finale: string
  type: 'pdf' | 'json' | 'html' | 'texte'
  titre: string
  editeur: string | null
  auteur: string | null
  date_publication: string | null
  texte: string
  fichier: string | null
  tronquee: boolean
  taille: number
}

const ENTITES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', ccedil: 'ç', ugrave: 'ù', ocirc: 'ô',
  icirc: 'î', iuml: 'ï', ucirc: 'û', acirc: 'â', euml: 'ë', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', hellip: '…', mdash: '—', ndash: '–', euro: '€', deg: '°',
  times: '×', middot: '·', bull: '•', trade: '™', copy: '©', reg: '®', permil: '‰',
}

export function decoderEntites(s: unknown): string {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => codePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, nom: string) => ENTITES[nom] ?? ENTITES[nom.toLowerCase()] ?? m)
}

function codePoint(n: number): string {
  try { return String.fromCodePoint(n) } catch { return '' }
}

const bloc = (nom: string): RegExp => new RegExp(`<${nom}\\b[^>]*>[\\s\\S]*?</${nom}>`, 'gi')

/** Ce qui n'est jamais du contenu : on l'enlève avant tout le reste. */
function degraisser(html: string): string {
  let s = html
  for (const nom of ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'form', 'select', 'button']) {
    s = s.replace(bloc(nom), ' ')
  }
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  return s
}

/** Le corps de l'article, s'il est identifiable ; sinon toute la page. */
function corps(html: string): string {
  for (const re of [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<div\b[^>]*(?:id|class)="[^"]*(?:article|content|post|entry|story)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<footer|$)/i,
  ]) {
    const m = html.match(re)
    if (m && m[1].replace(/<[^>]+>/g, '').trim().length > 900) return m[1]
  }
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  return body ? body[1] : html
}

/**
 * HTML → texte structuré. On garde les titres, les listes et les tableaux sous
 * forme Markdown légère : le modèle doit pouvoir citer un chiffre avec sa ligne.
 */
export function htmlVersTexte(html: string): string {
  let s = corps(degraisser(html))
  for (const nom of ['nav', 'header', 'footer', 'aside']) s = s.replace(bloc(nom), ' ')

  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|tr|h[1-6]|blockquote|figcaption)>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n\n${'#'.repeat(Math.min(Number(n) + 1, 6))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<(p|div|section|blockquote|table|figure)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')

  return decoderEntites(s)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function meta(html: string, ...cles: string[]): string | null {
  for (const cle of cles) {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${cle}["'][^>]*>`, 'i')
    const balise = html.match(re)?.[0]
    const valeur = balise?.match(/content=["']([^"']*)["']/i)?.[1]
    if (valeur?.trim()) return decoderEntites(valeur.trim())
  }
  return null
}

function hote(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return null }
}

/**
 * Normalise une URL pour comparer « ce qui est cité » à « ce qui a été lu » :
 * le fragment, le slash final et les paramètres de suivi ne changent pas la page.
 */
export function normaliserUrl(url: unknown): string {
  try {
    const u = new URL(String(url).trim())
    u.hash = ''
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_[a-z_]*|fbclid|gclid|mc_cid|mc_eid|igshid|ref|source)$/i.test(p)) u.searchParams.delete(p)
    }
    u.protocol = 'https:'
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
    let s = u.toString().replace(/\/$/, '')
    return s.replace(/\?$/, '')
  } catch {
    return String(url).trim().replace(/\/$/, '')
  }
}

/** Les URL citées dans un texte, dépouillées de la ponctuation qui les suit. */
export function urlsDuTexte(texte: unknown): string[] {
  const trouvees = new Set<string>()
  for (const brut of String(texte || '').match(/https?:\/\/[^\s<>"'`\]}]+/g) || []) {
    let u = brut
    let avant: string
    // La ponctuation qui suit une URL n'en fait pas partie ; une parenthèse
    // fermante, si — mais seulement quand une ouvrante la précède dans l'adresse.
    do {
      avant = u
      u = u.replace(/[.,;:!?»”]+$/, '')
      while (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) u = u.slice(0, -1)
    } while (u !== avant)
    if (u.length > 10) trouvees.add(u)
  }
  return [...trouvees]
}

/**
 * Va chercher la page. Un PDF n'est pas mis à plat : il est enregistré sur le
 * disque et le chemin est rendu — l'outil `Read` de Claude Code sait le lire.
 */
export async function recupererPage(
  url: string,
  { timeout = 30000, maxCaracteres = 60000 }: { timeout?: number, maxCaracteres?: number } = {},
): Promise<Page> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`« ${url} » n'est pas une adresse http(s).`)

  const ctrl = new AbortController()
  const minuteur = setTimeout(() => ctrl.abort(), timeout)
  let reponse: Response
  try {
    reponse = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
    })
  } catch (err) {
    clearTimeout(minuteur)
    const e = err as Error | undefined
    throw new Error(e?.name === 'AbortError'
      ? `Pas de réponse de ${hote(url) || url} après ${Math.round(timeout / 1000)} s.`
      : `Impossible de joindre ${hote(url) || url} : ${e?.message || err}`)
  }
  clearTimeout(minuteur)

  if (!reponse.ok) {
    throw new Error(`${hote(url) || url} répond ${reponse.status} ${reponse.statusText || ''}`.trim())
  }

  const ctype = (reponse.headers.get('content-type') || '').toLowerCase()
  const urlFinale = reponse.url || url

  if (ctype.includes('pdf')) {
    const octets = Buffer.from(await reponse.arrayBuffer())
    const nom = `${crypto.createHash('sha1').update(urlFinale).digest('hex').slice(0, 10)}.pdf`
    const fichier = path.join(P.pieces(), nom)
    fs.mkdirSync(P.pieces(), { recursive: true })
    fs.writeFileSync(fichier, octets)
    return {
      url, url_finale: urlFinale, type: 'pdf',
      titre: decodeURIComponent(urlFinale.split('/').pop() || 'document.pdf'),
      editeur: hote(urlFinale), auteur: null, date_publication: null,
      texte: '', fichier, tronquee: false, taille: octets.length,
    }
  }

  const brut = await reponse.text()

  if (ctype.includes('json')) {
    const texte = brut.slice(0, maxCaracteres)
    return {
      url, url_finale: urlFinale, type: 'json', titre: hote(urlFinale) || urlFinale,
      editeur: hote(urlFinale), auteur: null, date_publication: null,
      texte, fichier: null, tronquee: brut.length > maxCaracteres, taille: brut.length,
    }
  }

  const estHtml = ctype.includes('html') || ctype.includes('xml') || /<html|<body|<!doctype/i.test(brut.slice(0, 600))
  const texteComplet = estHtml ? htmlVersTexte(brut) : decoderEntites(brut).trim()

  const titre = estHtml
    ? (meta(brut, 'og:title', 'twitter:title')
      || decoderEntites(brut.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || '')
      || hote(urlFinale) || urlFinale)
    : (hote(urlFinale) || urlFinale)

  return {
    url,
    url_finale: urlFinale,
    type: estHtml ? 'html' : 'texte',
    titre: titre.slice(0, 220),
    editeur: meta(brut, 'og:site_name', 'application-name') || hote(urlFinale),
    auteur: meta(brut, 'author', 'article:author', 'og:article:author'),
    date_publication: meta(brut, 'article:published_time', 'article:modified_time', 'datePublished', 'date', 'dc.date'),
    texte: texteComplet.slice(0, maxCaracteres),
    fichier: null,
    tronquee: texteComplet.length > maxCaracteres,
    taille: texteComplet.length,
  }
}
