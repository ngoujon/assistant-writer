// Les conversations : un fichier JSON par fil, avec de quoi le rejouer à l'écran —
// et de quoi le reprendre.
//
// Deux choses cohabitent ici, qu'il ne faut pas confondre. Les `evenements` sont ce
// qui a DÉFILÉ dans la fenêtre : messages, sources lues, documents produits. L'
// `historique` est ce que le MODÈLE a en tête : les messages au format du serveur,
// appels d'outils compris. Le premier sert à repeindre l'écran, le second à reprendre
// le travail là où il s'était arrêté — c'est le SDK d'Anthropic qui gardait ce
// contexte pour nous ; il vit maintenant ici, sur le disque de Nicolas.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { P, ensureDonnees } from './paths.mjs'

/** Au-delà, un fil très long est tronqué par le début : seul l'affichage y perd. */
const MAX_EVENEMENTS = 400

/** Autant de messages de modèle conservés : bien plus que ce qui tient en contexte. */
const MAX_HISTORIQUE = 120

/** Un résultat d'outil très long est écourté sur le disque, pas en mémoire vive. */
const MAX_RESULTAT = 8000

const maintenant = () => new Date().toISOString()

export function nouvelId() {
  return `c${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
}

function chemin(id) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('Identifiant de conversation invalide.')
  return P.conversation(id)
}

export function lire(id) {
  try {
    const c = JSON.parse(fs.readFileSync(chemin(id), 'utf8'))
    return c && c.id ? c : null
  } catch {
    return null
  }
}

function ecrire(conv) {
  ensureDonnees()
  fs.writeFileSync(chemin(conv.id), JSON.stringify(conv))
  return conv
}

export function creer({ titre } = {}) {
  return ecrire({
    id: nouvelId(),
    titre: titre || null,
    cree_le: maintenant(),
    maj_le: maintenant(),
    sessionId: null,
    documents: [],
    evenements: [],
    historique: [],
  })
}

/** Les métadonnées seules : de quoi peindre la liste sans charger les fils. */
const resume = (c) => ({
  id: c.id,
  titre: c.titre || 'Nouvelle conversation',
  sansTitre: !c.titre,
  cree_le: c.cree_le,
  maj_le: c.maj_le,
  documents: c.documents?.length || 0,
  messages: c.evenements?.filter((e) => e.k === 'user').length || 0,
  // « termine », « interrompu », « incomplet » — ce qu'est devenu le dernier tour.
  statut: c.statut || null,
  vide: !c.evenements?.length,
})

/** Le texte où l'on cherche : titre, messages, titres de documents et de sources. */
function corpusDeRecherche(c) {
  const bouts = [c.titre || '']
  for (const e of c.evenements || []) {
    if (e.k === 'user' || e.k === 'texte') bouts.push(e.texte || '')
    else if (e.k === 'document') bouts.push(e.titre || '', e.nom || '')
    else if (e.k === 'source') bouts.push(e.titre || '', e.url || '')
    else if (e.k === 'outil') bouts.push(e.arg || '')
  }
  return bouts.join('\n').toLowerCase()
}

export function lister(recherche) {
  ensureDonnees()
  let noms = []
  try { noms = fs.readdirSync(P.conversations()) } catch { return [] }
  const q = String(recherche || '').trim().toLowerCase()
  const out = []
  for (const nom of noms) {
    if (!nom.endsWith('.json')) continue
    const c = lire(nom.slice(0, -5))
    if (!c) continue
    if (q && !corpusDeRecherche(c).includes(q)) continue
    out.push(resume(c))
  }
  // Le plus récemment touché d'abord. Deux écritures dans la même milliseconde
  // sont départagées par l'identifiant, qui commence par l'instant de création :
  // l'ordre affiché ne saute donc pas d'un appel à l'autre.
  return out.sort((a, b) => b.maj_le.localeCompare(a.maj_le) || b.id.localeCompare(a.id))
}

export function supprimer(id) {
  try { fs.rmSync(chemin(id), { force: true }) } catch {}
  return true
}

/**
 * Renomme un fil. Un titre posé à la main est définitif : ni le modèle ni le
 * titre d'un document ne le recouvrent ensuite.
 */
export function renommer(id, titre, { manuel = true } = {}) {
  const c = lire(id)
  if (!c) return null
  if (!manuel && c.titreManuel) return resume(c)
  c.titre = String(titre || '').trim().slice(0, 120) || null
  if (manuel) c.titreManuel = true
  c.maj_le = maintenant()
  return resume(ecrire(c))
}

/** Où en est le dernier tour de ce fil : c'est ce qui distingue « fini » de « en plan ». */
export function marquerStatut(id, statut) {
  const c = lire(id)
  if (!c || c.statut === statut) return null
  c.statut = statut
  return resume(ecrire(c))
}

/**
 * Enregistre le contexte du modèle. Écrit à chaque étape d'outil : une application
 * qui s'arrête en pleine recherche doit pouvoir la reprendre, pas la recommencer.
 */
export function memoriserHistorique(id, messages) {
  const c = lire(id)
  if (!c || !Array.isArray(messages)) return
  let taille = messages.slice(-MAX_HISTORIQUE).map((m) => (
    typeof m.content === 'string' && m.content.length > MAX_RESULTAT && m.role === 'tool'
      ? { ...m, content: `${m.content.slice(0, MAX_RESULTAT)}\n…[résultat écourté]` }
      : m
  ))
  // Un message d'outil sans l'appel qui l'a provoqué ferait refuser la reprise par
  // le serveur : on coupe proprement, au premier message qui n'en est pas un.
  while (taille.length && taille[0].role === 'tool') taille = taille.slice(1)
  c.historique = taille
  ecrire(c)
}

/** Le contexte du modèle pour ce fil, tel qu'il a été laissé. */
export function historique(id) {
  const c = lire(id)
  return Array.isArray(c?.historique) ? c.historique : []
}

export function memoriserSession(id, sessionId) {
  const c = lire(id)
  if (!c || c.sessionId === sessionId) return
  c.sessionId = sessionId
  ecrire(c)
}

/**
 * Ajoute un événement au fil. Le titre se fabrique tout seul : la première
 * demande de Nicolas, puis le titre du document dès qu'il en sort un — c'est ce
 * qu'on cherche des semaines plus tard, pas « Nouvelle conversation ».
 */
export function ajouter(id, evenement) {
  const c = lire(id)
  if (!c) return null
  c.evenements.push({ ...evenement, t: maintenant() })
  if (c.evenements.length > MAX_EVENEMENTS) c.evenements.splice(0, c.evenements.length - MAX_EVENEMENTS)
  if (evenement.k === 'user' && !c.titre) c.titre = titreDepuisTexte(evenement.texte)
  if (evenement.k === 'document') {
    if (evenement.nom && !c.documents.includes(evenement.nom)) c.documents.push(evenement.nom)
    if (evenement.titre && !c.titreManuel) c.titre = evenement.titre.slice(0, 120)
  }
  c.maj_le = maintenant()
  ecrire(c)
  return resume(c)
}

export function titreDepuisTexte(texte) {
  const t = String(texte || '').replace(/\s+/g, ' ').trim()
  if (!t) return null
  if (t.length <= 60) return t
  const coupe = t.slice(0, 60)
  const espace = coupe.lastIndexOf(' ')
  return `${(espace > 30 ? coupe.slice(0, espace) : coupe).trim()}…`
}

/**
 * Les noms de fichiers des documents écrits par ce fil.
 *
 * À ne pas confondre avec le `documents` du résumé, qui en est le **nombre** :
 * ce sont deux réponses à deux questions différentes, et les mélanger casse.
 */
export function documentsDe(id) {
  const c = lire(id)
  return Array.isArray(c?.documents) ? [...c.documents] : []
}

/** Le fil complet, prêt à être rejoué par l'interface. */
export function fil(id) {
  const c = lire(id)
  return c ? { ...resume(c), sessionId: c.sessionId, evenements: c.evenements } : null
}
