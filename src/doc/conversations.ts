// Les conversations : un fichier JSON par fil, avec de quoi le rejouer à l'écran.
//
// Le SDK sait reprendre une conversation côté modèle (`resume`), mais il ne rend
// pas ce qui a été affiché. On garde donc ici une trace légère de ce qui a défilé
// dans la fenêtre — messages, sources lues, documents produits — pour qu'un
// retour sur un ancien fil retrouve exactement ce qu'on y avait vu.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { P, ensureDonnees } from './paths.ts'

/** Au-delà, un fil très long est tronqué par le début : seul l'affichage y perd. */
const MAX_EVENEMENTS = 400

/** Ce qui a défilé dans la fenêtre, en assez peu de mots pour être rejoué. */
export type EvenementFil =
  | { k: 'user', texte: string }
  | { k: 'texte', texte: string }
  | { k: 'outil', nom: string, arg: string }
  | { k: 'source', id: string, titre: string, url: string }
  | {
    k: 'document', nom: string, titre: string, mots?: number, sources?: number,
    version?: number, remplace?: boolean,
  }
  | { k: 'note', texte: string, kind?: string }

/** Un événement tel qu'il est enregistré : daté. */
export type EvenementDate = EvenementFil & { t: string }

/** Ce qu'est devenu le dernier tour d'un fil. */
export type StatutFil = 'termine' | 'interrompu' | 'incomplet'

/** Un fil tel qu'il vit sur le disque. */
export interface Conversation {
  id: string
  titre: string | null
  titreManuel?: boolean
  cree_le: string
  maj_le: string
  sessionId: string | null
  documents: string[]
  evenements: EvenementDate[]
  statut?: StatutFil | null
}

/** Une ligne de la liste des fils. */
export interface ResumeConversation {
  id: string
  titre: string
  sansTitre: boolean
  cree_le: string
  maj_le: string
  /** Le nombre de documents écrits — pas leurs noms (voir `documentsDe`). */
  documents: number
  messages: number
  statut: StatutFil | null
  vide: boolean
}

/** Un fil complet, prêt à être rejoué. */
export interface FilConversation extends ResumeConversation {
  sessionId: string | null
  evenements: EvenementDate[]
}

const maintenant = () => new Date().toISOString()

export function nouvelId(): string {
  return `c${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
}

function chemin(id: unknown): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('Identifiant de conversation invalide.')
  return P.conversation(String(id))
}

export function lire(id: unknown): Conversation | null {
  try {
    const c = JSON.parse(fs.readFileSync(chemin(id), 'utf8'))
    return c && c.id ? c : null
  } catch {
    return null
  }
}

function ecrire(conv: Conversation): Conversation {
  ensureDonnees()
  fs.writeFileSync(chemin(conv.id), JSON.stringify(conv))
  return conv
}

export function creer({ titre }: { titre?: string | null } = {}): Conversation {
  return ecrire({
    id: nouvelId(),
    titre: titre || null,
    cree_le: maintenant(),
    maj_le: maintenant(),
    sessionId: null,
    documents: [],
    evenements: [],
  })
}

/** Les métadonnées seules : de quoi peindre la liste sans charger les fils. */
const resume = (c: Conversation): ResumeConversation => ({
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
function corpusDeRecherche(c: Conversation): string {
  const bouts = [c.titre || '']
  for (const e of c.evenements || []) {
    if (e.k === 'user' || e.k === 'texte') bouts.push(e.texte || '')
    else if (e.k === 'document') bouts.push(e.titre || '', e.nom || '')
    else if (e.k === 'source') bouts.push(e.titre || '', e.url || '')
    else if (e.k === 'outil') bouts.push(e.arg || '')
  }
  return bouts.join('\n').toLowerCase()
}

export function lister(recherche?: string | null): ResumeConversation[] {
  ensureDonnees()
  let noms: string[] = []
  try { noms = fs.readdirSync(P.conversations()) } catch { return [] }
  const q = String(recherche || '').trim().toLowerCase()
  const out: ResumeConversation[] = []
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

export function supprimer(id: unknown): true {
  try { fs.rmSync(chemin(id), { force: true }) } catch {}
  return true
}

/**
 * Renomme un fil. Un titre posé à la main est définitif : ni le modèle ni le
 * titre d'un document ne le recouvrent ensuite.
 */
export function renommer(
  id: unknown,
  titre: string | null | undefined,
  { manuel = true }: { manuel?: boolean } = {},
): ResumeConversation | null {
  const c = lire(id)
  if (!c) return null
  if (!manuel && c.titreManuel) return resume(c)
  c.titre = String(titre || '').trim().slice(0, 120) || null
  if (manuel) c.titreManuel = true
  c.maj_le = maintenant()
  return resume(ecrire(c))
}

/** Où en est le dernier tour de ce fil : c'est ce qui distingue « fini » de « en plan ». */
export function marquerStatut(id: unknown, statut: StatutFil): ResumeConversation | null {
  const c = lire(id)
  if (!c || c.statut === statut) return null
  c.statut = statut
  return resume(ecrire(c))
}

export function memoriserSession(id: unknown, sessionId: string): void {
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
export function ajouter(id: unknown, evenement: EvenementFil): ResumeConversation | null {
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

export function titreDepuisTexte(texte: unknown): string | null {
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
export function documentsDe(id: unknown): string[] {
  const c = lire(id)
  return Array.isArray(c?.documents) ? [...c.documents] : []
}

/** Le fil complet, prêt à être rejoué par l'interface. */
export function fil(id: unknown): FilConversation | null {
  const c = lire(id)
  return c ? { ...resume(c), sessionId: c.sessionId, evenements: c.evenements } : null
}
