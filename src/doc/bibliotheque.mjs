// La bibliothèque : des fichiers .md ordinaires, dans un dossier ordinaire.
// Rien d'exotique — Nicolas doit pouvoir les ouvrir, les déplacer et les
// sauvegarder sans l'application.
import fs from 'node:fs'
import path from 'node:path'
import { P, ensureDirs, VERSIONS } from './paths.mjs'
import { parId, ligneBibliographie, jolieDate } from './sources.mjs'

const TITRE_SOURCES = '## Sources'
export const LISEZ_MOI = 'LISEZ-MOI.md'

export function slug(titre) {
  return String(titre || 'document')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'document'
}

function aujourdhui() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function nomFichier(titre) {
  return `${aujourdhui()}-${slug(titre)}.md`
}

/** Un nom de fichier qui reste dans la bibliothèque, quoi qu'on lui donne. */
function nomSur(nom) {
  const base = path.basename(String(nom || '').trim())
  if (!base || base === '.' || base === '..') throw new Error('Nom de document invalide.')
  return base.endsWith('.md') ? base : `${base}.md`
}

// -------------------------------------------------------------- métadonnées
//
// Les informations de production (version, dates, modèle) ne sont pas ce qu'on
// vient lire : elles vivent en fin de document, dans une section lisible, et sous
// forme lisible par la machine dans un commentaire HTML — invisible à l'affichage,
// mais suffisant pour retrouver la version d'un document sans le relire en entier.

const MARQUEUR = 'assistant-redacteur:'
const RE_META = /\n?<!--\s*assistant-redacteur:\s*(\{[\s\S]*?\})\s*-->\s*$/
const RE_APROPOS = /\n+(?:---\n+)?##\s+À propos de ce document[\s\S]*$/

export function separerMeta(brut) {
  const texte = String(brut)

  // Format actuel : le bloc technique est en queue de document.
  const m = texte.match(RE_META)
  if (m) {
    let meta = {}
    try { meta = JSON.parse(m[1]) } catch {}
    return { meta, corps: texte.slice(0, m.index).replace(RE_APROPOS, '').trimEnd() }
  }

  // Ancien format : en-tête YAML. On sait encore le lire — les documents déjà
  // écrits ne doivent pas devenir illisibles parce que la mise en page a changé.
  const y = texte.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!y) return { meta: {}, corps: texte }
  const meta = {}
  for (const ligne of y[1].split('\n')) {
    const kv = ligne.match(/^([a-z_]+)\s*:\s*(.*)$/i)
    if (!kv) continue
    let v = kv[2].trim()
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"')
    meta[kv[1]] = /^\d+$/.test(v) ? Number(v) : v
  }
  return { meta, corps: texte.slice(y[0].length) }
}

/** L'ancre d'un titre, à la façon de GitHub : c'est ce que suivent les liseuses. */
export function ancre(titre) {
  return String(titre)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

/**
 * Le sommaire, construit à partir des titres réellement présents. Composé ici et
 * non par le modèle : une table des matières qui ment est pire que pas de table.
 */
export function composerSommaire(corps) {
  const titres = []
  let dansCode = false
  for (const ligne of String(corps).split('\n')) {
    if (/^\s*```/.test(ligne)) { dansCode = !dansCode; continue }
    if (dansCode) continue
    const m = ligne.match(/^(#{2,3})\s+(.+?)\s*$/)
    if (m) titres.push({ niveau: m[1].length, texte: m[2].replace(/\s*#+\s*$/, '') })
  }
  if (titres.length < 3) return ''
  const lignes = titres.map((t) => `${t.niveau === 3 ? '  ' : ''}- [${t.texte}](#${ancre(t.texte)})`)
  return `## Sommaire\n\n${lignes.join('\n')}\n`
}

function blocAPropos(meta) {
  const lignes = [
    '## À propos de ce document',
    '',
    `- **Version ${meta.version}** — mise à jour le ${jolieDate(meta.mis_a_jour_le) || meta.mis_a_jour_le}`,
    `- Créé le ${jolieDate(meta.cree_le) || meta.cree_le}`,
    `- ${meta.sources} source${meta.sources > 1 ? 's' : ''} consultée${meta.sources > 1 ? 's' : ''}`,
  ]
  if (meta.sujet) lignes.push(`- Demande : « ${meta.sujet} »`)
  lignes.push(`- Rédigé par l'Assistant Rédacteur${meta.modele ? ` (${meta.modele})` : ''}`)
  lignes.push('', `<!-- ${MARQUEUR} ${JSON.stringify(meta)} -->`, '')
  return lignes.join('\n')
}

// ----------------------------------------------------------------- lecture

export function compterMots(texte) {
  return (String(texte).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length
}

function infoDepuisFichier(nom) {
  const chemin = P.document(nom)
  const stat = fs.statSync(chemin)
  const brut = fs.readFileSync(chemin, 'utf8')
  const { meta: entete, corps } = separerMeta(brut)
  return {
    nom,
    chemin,
    titre: entete.titre || corps.match(/^#\s+(.*)$/m)?.[1] || nom.replace(/\.md$/, ''),
    sujet: entete.sujet || null,
    cree_le: entete.cree_le || stat.birthtime.toISOString().slice(0, 10),
    mis_a_jour_le: entete.mis_a_jour_le || stat.mtime.toISOString().slice(0, 10),
    sources: Number(entete.sources || 0),
    version: Number(entete.version || 1),
    versions: compterVersions(nom),
    mots: Number(entete.mots) || compterMots(corps),
    octets: stat.size,
    modifie_a: stat.mtime.toISOString(),
  }
}

export function listerDocuments() {
  ensureDirs()
  let noms = []
  try { noms = fs.readdirSync(P.bibliotheque()) } catch { return [] }
  const docs = []
  for (const nom of noms) {
    if (!nom.endsWith('.md') || nom.startsWith('.') || nom === VERSIONS) continue
    // Le mot d'accueil posé à la première ouverture n'est pas un document.
    if (nom === LISEZ_MOI) continue
    try { docs.push(infoDepuisFichier(nom)) } catch {}
  }
  // Le plus récent d'abord. Deux écritures dans la même milliseconde sont
  // départagées par le nom, pour que l'ordre affiché ne bouge pas d'un appel à l'autre.
  return docs.sort((a, b) => b.modifie_a.localeCompare(a.modifie_a) || b.nom.localeCompare(a.nom))
}

export function existe(nom) {
  try { return fs.statSync(P.document(nomSur(nom))).isFile() } catch { return false }
}

export function lireDocument(nom) {
  const fichier = nomSur(nom)
  if (!existe(fichier)) throw new Error(`Aucun document « ${fichier} » dans la bibliothèque.`)
  const brut = fs.readFileSync(P.document(fichier), 'utf8')
  const { meta: entete, corps } = separerMeta(brut)
  return { ...infoDepuisFichier(fichier), entete, markdown: corps }
}

export function supprimerDocument(nom) {
  const fichier = nomSur(nom)
  fs.rmSync(P.document(fichier), { force: true })
  supprimerVersions(fichier)
  return fichier
}

// -------------------------------------------------------------- écriture

/**
 * La bibliographie n'est pas écrite par le modèle : elle est composée à partir du
 * registre des sources. Une référence ne peut donc être ni approximative ni inventée.
 */
export function composerBibliographie(ids) {
  const lignes = []
  let i = 0
  for (const id of ids) {
    const s = parId(id)
    if (!s) continue
    lignes.push(ligneBibliographie(s, ++i))
  }
  if (!lignes.length) return ''
  return `${TITRE_SOURCES}\n\n${lignes.join('\n\n')}\n`
}

/** Retire un sommaire ou un bloc « À propos » que le modèle aurait écrit lui-même. */
function sansSommaire(markdown) {
  return String(markdown).replace(/^#{2,3}\s*(Sommaire|Table des mati[eè]res)\s*\n[\s\S]*?(?=\n#{1,3}\s)/im, '')
}

function sansAPropos(markdown) {
  return String(markdown).replace(/\n+(?:---\n+)?#{2,3}\s+À propos de ce document[\s\S]*$/i, '\n').trimEnd()
}

/** Glisse le sommaire juste avant la première section : après le titre et le résumé. */
function avecSommaire(corps) {
  const sommaire = composerSommaire(corps)
  if (!sommaire) return corps
  const lignes = corps.split('\n')
  const i = lignes.findIndex((l, n) => n > 0 && /^##\s+/.test(l))
  if (i < 0) return `${corps}\n\n${sommaire}`
  return `${lignes.slice(0, i).join('\n').trimEnd()}\n\n${sommaire}\n${lignes.slice(i).join('\n')}`
}

/** Retire la section « Sources » que le modèle aurait écrite lui-même. */
function sansSectionSources(markdown) {
  const re = /\n#{2,3}\s*(Sources|Sources consultées|Bibliographie|Références)\s*\n[\s\S]*$/i
  return String(markdown).replace(re, '\n').trimEnd()
}

/**
 * Enregistre un document. Le corps vient du modèle ; l'en-tête et la
 * bibliographie sont composés ici.
 */
export function ecrireDocument({ titre, sujet, markdown, sources = [], nom, modele }) {
  ensureDirs()
  if (!titre?.trim()) throw new Error('Un document a besoin d\'un titre.')
  if (!markdown?.trim()) throw new Error('Le document est vide.')

  const fichier = nom ? nomSur(nom) : nomFichier(titre)
  const chemin = P.document(fichier)
  const dejaLa = existe(fichier)
  // Réécrire ne détruit rien : la version en place part d'abord aux archives.
  // C'est ce qui permet de retoucher un document en conversation sans jamais
  // avoir à demander « tu confirmes ? ».
  const ancien = dejaLa ? separerMeta(fs.readFileSync(chemin, 'utf8')).meta : {}
  if (dejaLa) archiver(fichier)

  let corps = sansSectionSources(markdown).trim()
  corps = sansSommaire(sansAPropos(corps))
  if (!/^#\s+/.test(corps.split('\n')[0] || '')) corps = `# ${titre.trim()}\n\n${corps}`

  const meta = {
    titre: titre.trim(),
    sujet: sujet?.trim() || undefined,
    cree_le: ancien.cree_le || aujourdhui(),
    mis_a_jour_le: aujourdhui(),
    version: Number(ancien.version || 0) + 1,
    sources: sources.filter((id) => parId(id)).length,
    mots: compterMots(corps),
    modele: modele || undefined,
  }

  const biblio = composerBibliographie(sources)
  const contenu = [
    avecSommaire(corps),
    biblio ? `\n\n---\n\n${biblio}` : '\n',
    `\n---\n\n${blocAPropos(meta)}`,
  ].join('')

  fs.writeFileSync(chemin, contenu)
  return {
    ...infoDepuisFichier(fichier),
    remplace: dejaLa,
    sources_citees: biblio ? sources.filter((id) => parId(id)).length : 0,
  }
}

// -------------------------------------------------------------- versions
//
// Un document se retouche en conversation : chaque écriture pousse la précédente
// dans « Versions/ », numérotée. Rien ne se perd, donc rien ne se valide.

function dossierVersions(nom) {
  return P.versions(nom)
}

function compterVersions(nom) {
  try {
    return fs.readdirSync(dossierVersions(nom)).filter((f) => /^v\d+\.md$/.test(f)).length
  } catch {
    return 0
  }
}

/** Range la version en place dans les archives, sous son propre numéro. */
function archiver(fichier) {
  const chemin = P.document(fichier)
  let brut
  try { brut = fs.readFileSync(chemin, 'utf8') } catch { return null }
  const { meta: entete } = separerMeta(brut)
  const n = Number(entete.version || compterVersions(fichier) + 1) || 1
  const dossier = dossierVersions(fichier)
  fs.mkdirSync(dossier, { recursive: true })
  const cible = path.join(dossier, `v${n}.md`)
  fs.writeFileSync(cible, brut)
  return cible
}

/** L'historique d'un document : la version en place, puis les précédentes. */
export function versionsDocument(nom) {
  const fichier = nomSur(nom)
  const out = []
  if (existe(fichier)) {
    const info = infoDepuisFichier(fichier)
    out.push({
      numero: info.version, courante: true, chemin: info.chemin,
      mots: info.mots, sources: info.sources, date: info.mis_a_jour_le, modifie_a: info.modifie_a,
    })
  }
  let noms = []
  try { noms = fs.readdirSync(dossierVersions(fichier)) } catch { noms = [] }
  for (const f of noms) {
    const m = f.match(/^v(\d+)\.md$/)
    if (!m) continue
    const chemin = path.join(dossierVersions(fichier), f)
    try {
      const brut = fs.readFileSync(chemin, 'utf8')
      const { meta: entete, corps } = separerMeta(brut)
      const stat = fs.statSync(chemin)
      out.push({
        numero: Number(m[1]), courante: false, chemin,
        mots: compterMots(corps), sources: Number(entete.sources || 0),
        date: entete.mis_a_jour_le || stat.mtime.toISOString().slice(0, 10),
        modifie_a: stat.mtime.toISOString(),
      })
    } catch {}
  }
  return out.sort((a, b) => b.numero - a.numero)
}

export function lireVersion(nom, numero) {
  const v = versionsDocument(nom).find((x) => x.numero === Number(numero))
  if (!v) throw new Error(`Le document « ${nomSur(nom)} » n'a pas de version ${numero}.`)
  const brut = fs.readFileSync(v.chemin, 'utf8')
  const { meta: entete, corps } = separerMeta(brut)
  return { ...v, nom: nomSur(nom), entete, markdown: corps }
}

/**
 * Remet une ancienne version en place. Elle devient la version courante — sous un
 * nouveau numéro : revenir en arrière est aussi un pas en avant, et l'état d'où
 * l'on revient reste consultable.
 */
export function restaurerVersion(nom, numero) {
  const fichier = nomSur(nom)
  const v = lireVersion(fichier, numero)
  if (v.courante) throw new Error(`La version ${numero} est déjà celle en place.`)
  const enPlace = separerMeta(fs.readFileSync(P.document(fichier), 'utf8')).meta
  archiver(fichier)
  // Le texte revient tel quel ; seules les métadonnées avancent d'un cran, avec
  // la trace de ce qu'on a restauré.
  const meta = {
    ...v.entete,
    mis_a_jour_le: aujourdhui(),
    version: Number(enPlace.version || 1) + 1,
    restauree_depuis: Number(numero),
  }
  fs.writeFileSync(P.document(fichier), `${v.markdown.trimEnd()}\n\n---\n\n${blocAPropos(meta)}`)
  return { ...infoDepuisFichier(fichier), restauree_depuis: Number(numero) }
}

export function supprimerVersions(nom) {
  try { fs.rmSync(dossierVersions(nomSur(nom)), { recursive: true, force: true }) } catch {}
}

export { jolieDate }
