// Le registre des sources : la mémoire de ce qui a été RÉELLEMENT lu.
//
// C'est la pièce qui rend les documents fiables. Une URL ne devient citable qu'en
// passant par ici — donc en ayant répondu. Les gardes (voir agent/gardes.mjs)
// refusent tout document qui cite une adresse absente de ce registre : l'assistant
// ne peut pas inventer une référence, même s'il en a envie.
import fs from 'node:fs'
import path from 'node:path'
import { P } from './paths.mjs'
import { recupererPage, normaliserUrl } from './web.mjs'

function lireRegistre() {
  try {
    const data = JSON.parse(fs.readFileSync(P.registre(), 'utf8'))
    return Array.isArray(data?.sources) ? data : { sequence: 0, sources: [] }
  } catch {
    return { sequence: 0, sources: [] }
  }
}

function ecrireRegistre(reg) {
  fs.mkdirSync(path.dirname(P.registre()), { recursive: true })
  fs.writeFileSync(P.registre(), JSON.stringify(reg, null, 2))
}

const publique = (s) => ({
  id: s.id,
  titre: s.titre,
  editeur: s.editeur,
  auteur: s.auteur || undefined,
  url: s.url_finale || s.url,
  date_publication: s.date_publication || undefined,
  consultee_le: s.consultee_le,
  type: s.type,
  fichier: s.fichier || undefined,
  caracteres: s.taille,
})

export function registre() {
  return lireRegistre().sources.map(publique)
}

export function parId(id) {
  const s = lireRegistre().sources.find((x) => x.id === String(id).trim())
  return s ? publique(s) : null
}

export function parUrl(url) {
  const cle = normaliserUrl(url)
  const s = lireRegistre().sources.find((x) => x.cle === cle || normaliserUrl(x.url_finale || x.url) === cle)
  return s ? publique(s) : null
}

/** Toutes les adresses que l'assistant a le droit de citer. */
export function urlsCitables() {
  const set = new Set()
  for (const s of lireRegistre().sources) {
    set.add(s.cle)
    if (s.url_finale) set.add(normaliserUrl(s.url_finale))
    if (s.url) set.add(normaliserUrl(s.url))
  }
  return set
}

/** Le texte intégral d'une source déjà consultée, tel qu'il a été enregistré. */
export function texteSource(id) {
  const s = parId(id)
  if (!s) return null
  try { return fs.readFileSync(P.source(s.id), 'utf8') } catch { return null }
}

/**
 * Va lire une page et l'inscrit au registre. Une page déjà lue n'est pas
 * re-téléchargée dans la foulée : on rend le texte conservé, en disant depuis quand.
 * @returns {Promise<{source: object, texte: string, deja_lue: boolean, tronquee: boolean}>}
 */
export async function consulter(url, { relire = false, maxCaracteres = 60000 } = {}) {
  const cle = normaliserUrl(url)
  const reg = lireRegistre()
  const connue = reg.sources.find((s) => s.cle === cle)

  if (connue && !relire) {
    const texte = (() => {
      try { return fs.readFileSync(P.source(connue.id), 'utf8') } catch { return '' }
    })()
    if (texte || connue.type === 'pdf') {
      return { source: publique(connue), texte, deja_lue: true, tronquee: !!connue.tronquee }
    }
  }

  const page = await recupererPage(url, { maxCaracteres })
  const id = connue?.id || `s${++reg.sequence}`
  const entree = {
    id,
    cle,
    url: page.url,
    url_finale: page.url_finale,
    type: page.type,
    titre: page.titre,
    editeur: page.editeur,
    auteur: page.auteur,
    date_publication: page.date_publication,
    consultee_le: new Date().toISOString(),
    taille: page.taille,
    tronquee: page.tronquee,
    fichier: page.fichier,
  }
  if (connue) Object.assign(connue, entree)
  else reg.sources.push(entree)
  if (!connue) reg.sequence = Math.max(reg.sequence, Number(String(id).slice(1)) || 0)

  fs.mkdirSync(path.dirname(P.source(id)), { recursive: true })
  fs.writeFileSync(P.source(id), page.texte || '')
  ecrireRegistre(reg)

  return { source: publique(entree), texte: page.texte, deja_lue: false, tronquee: page.tronquee }
}

/** Une ligne de bibliographie, en français, avec la date de consultation. */
export function ligneBibliographie(s, index) {
  const bouts = [`**${s.titre}**`]
  if (s.auteur) bouts.push(s.auteur)
  if (s.editeur && s.editeur !== s.titre) bouts.push(s.editeur)
  const date = jolieDate(s.date_publication)
  if (date) bouts.push(`publié le ${date}`)
  const tete = `${index}. ${bouts.join(' — ')}`
  return `${tete}\n   <${s.url}>\n   *consultée le ${jolieDate(s.consultee_le) || s.consultee_le}*`
}

export function jolieDate(v) {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(+d)) return null
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** Uniquement pour les tests : repart d'un registre vierge. */
export function viderRegistre() {
  ecrireRegistre({ sequence: 0, sources: [] })
}
