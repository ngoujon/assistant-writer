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

// ------------------------------------------------------------- frontmatter

function echapper(v) {
  const s = String(v ?? '').replace(/"/g, '\\"')
  return `"${s}"`
}

export function separerFrontmatter(brut) {
  const m = String(brut).match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { entete: {}, corps: String(brut) }
  const entete = {}
  for (const ligne of m[1].split('\n')) {
    const kv = ligne.match(/^([a-z_]+)\s*:\s*(.*)$/i)
    if (!kv) continue
    let v = kv[2].trim()
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"')
    entete[kv[1]] = v
  }
  return { entete, corps: String(brut).slice(m[0].length) }
}

function composerFrontmatter(e) {
  const lignes = ['---']
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined || v === null || v === '') continue
    lignes.push(`${k}: ${typeof v === 'number' ? v : echapper(v)}`)
  }
  lignes.push('---', '')
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
  const { entete, corps } = separerFrontmatter(brut)
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
    mots: compterMots(corps),
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
  const { entete, corps } = separerFrontmatter(brut)
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
  const ancien = dejaLa ? separerFrontmatter(fs.readFileSync(chemin, 'utf8')).entete : {}
  if (dejaLa) archiver(fichier)

  let corps = sansSectionSources(markdown).trim()
  if (!/^#\s+/m.test(corps.split('\n')[0] || '')) corps = `# ${titre.trim()}\n\n${corps}`

  const biblio = composerBibliographie(sources)
  const contenu = [
    composerFrontmatter({
      titre: titre.trim(),
      sujet: sujet?.trim() || undefined,
      cree_le: ancien.cree_le || aujourdhui(),
      mis_a_jour_le: aujourdhui(),
      version: Number(ancien.version || 0) + 1,
      sources: biblio ? sources.filter((id) => parId(id)).length : 0,
      modele: modele || undefined,
      redige_par: 'Assistant Rédacteur',
    }),
    corps,
    biblio ? `\n\n---\n\n${biblio}` : '\n',
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
  const { entete } = separerFrontmatter(brut)
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
      const { entete, corps } = separerFrontmatter(brut)
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
  const { entete, corps } = separerFrontmatter(brut)
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
  archiver(fichier)
  const { entete } = separerFrontmatter(fs.readFileSync(P.document(fichier), 'utf8'))
  const nouveau = Number(entete.version || 1) + 1
  const brut = fs.readFileSync(v.chemin, 'utf8')
  const remis = brut.replace(/^(---\n[\s\S]*?)\nversion: \d+/m, `$1\nversion: ${nouveau}`)
  fs.writeFileSync(P.document(fichier), remis.includes(`version: ${nouveau}`) ? remis : brut)
  return { ...infoDepuisFichier(fichier), restauree_depuis: Number(numero) }
}

export function supprimerVersions(nom) {
  try { fs.rmSync(dossierVersions(nomSur(nom)), { recursive: true, force: true }) } catch {}
}

export { jolieDate }
