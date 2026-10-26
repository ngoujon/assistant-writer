// Plusieurs conversations qui travaillent en même temps.
//
// Une session = un processus Claude Code. On en laisse deux tourner de front :
// au-delà, la machine rame et les recherches se marchent dessus. Les demandes
// suivantes attendent leur tour, et partent dès qu'une place se libère.
//
// Le point important : **naviguer n'interrompt rien**. Changer de conversation ne
// fait que changer ce qu'on regarde ; ce qui tourne continue de tourner, et son
// fil se remplit en arrière-plan.
import { tracer } from '../doc/journal.ts'

export const MAX_EN_PARALLELE = 2

/** `travaille` (un tour est en cours), `attend` (une place se libère), ou `libre`. */
export type EtatFil = 'travaille' | 'attend' | 'libre'

/** Ce que le pool attend d'une session : AgentSession, ou une doublure dans les tests. */
export interface SessionPilotable {
  readonly running: boolean
  start(o?: { resume?: string }): void
  send(texte: string): void
  stop(): void
  interrupt(): unknown
  setModel(model: string): unknown
}

export interface OptionsPool {
  /** Fabrique une session branchée sur ce fil. */
  creerSession: (convId: string) => SessionPilotable
  /** Identifiant de session à reprendre. */
  repriseDe?: (convId: string) => string | undefined
  /** Prévient d'un changement d'état. */
  surEtat?: (convId: string, etat: EtatFil) => void
  max?: number
}

interface Fil {
  session: SessionPilotable | null
  occupe: boolean
  enAttente: string[]
}

export class Pool {
  creerSession: (convId: string) => SessionPilotable
  repriseDe: (convId: string) => string | undefined
  surEtat: (convId: string, etat: EtatFil) => void
  max: number
  fils: Map<string, Fil>
  /** Ordre d'arrivée des fils qui attendent une place. */
  file: string[]
  /** Le fil affiché : sa session reste chaude, pour que la frappe réponde tout de suite. */
  affiche: string | null

  constructor({ creerSession, repriseDe, surEtat, max = MAX_EN_PARALLELE }: OptionsPool) {
    this.creerSession = creerSession
    this.repriseDe = repriseDe || (() => undefined)
    this.surEtat = surEtat || (() => {})
    this.max = max
    this.fils = new Map()
    this.file = []
    this.affiche = null
  }

  // ------------------------------------------------------------------ états

  /** `travaille` (un tour est en cours), `attend` (une place se libère), ou `libre`. */
  etat(convId: string): EtatFil {
    const f = this.fils.get(convId)
    if (f?.occupe) return 'travaille'
    if (f?.enAttente.length) return 'attend'
    return 'libre'
  }

  etats(): Map<string, EtatFil> {
    const out = new Map<string, EtatFil>()
    for (const [id] of this.fils) out.set(id, this.etat(id))
    return out
  }

  occupes(): number {
    let n = 0
    for (const f of this.fils.values()) if (f.occupe) n += 1
    return n
  }

  #entree(convId: string): Fil {
    let f = this.fils.get(convId)
    if (!f) {
      f = { session: null, occupe: false, enAttente: [] }
      this.fils.set(convId, f)
    }
    return f
  }

  #demarrer(convId: string): SessionPilotable {
    const f = this.#entree(convId)
    if (f.session?.running) return f.session
    f.session = this.creerSession(convId)
    f.session.start({ resume: this.repriseDe(convId) })
    return f.session
  }

  // ------------------------------------------------------------------ envoi

  /**
   * Envoie une demande. Trois cas : le fil travaille déjà (le message rejoint sa
   * file d'entrée et il en tiendra compte), une place est libre (on part tout de
   * suite), ou tout est pris (on attend son tour).
   */
  envoyer(convId: string, texte: string): 'envoye' | 'attente' {
    const f = this.#entree(convId)

    if (f.occupe && f.session) {
      f.session.send(texte)
      return 'envoye'
    }

    if (this.occupes() >= this.max) {
      f.enAttente.push(texte)
      if (!this.file.includes(convId)) this.file.push(convId)
      tracer('fil mis en attente', convId, `(${this.occupes()} en traitement)`)
      this.surEtat(convId, 'attend')
      return 'attente'
    }

    this.#lancer(convId, texte)
    return 'envoye'
  }

  #lancer(convId: string, texte: string): void {
    const f = this.#entree(convId)
    const session = this.#demarrer(convId)
    f.occupe = true
    this.file = this.file.filter((id) => id !== convId)
    session.send(texte)
    this.surEtat(convId, 'travaille')
  }

  /** Un tour vient de se terminer : on libère la place et on fait avancer la file. */
  finDeTour(convId: string): void {
    const f = this.fils.get(convId)
    if (!f) return
    f.occupe = false

    if (f.enAttente.length) {
      // Ses propres messages en attente passent en premier : c'est son tour.
      const texte = f.enAttente.splice(0, f.enAttente.length).join('\n\n')
      this.#lancer(convId, texte)
      return
    }

    // Un fil qui ne travaille plus et qu'on ne regarde pas rend son processus.
    // Son contexte, lui, est enregistré : il se reprend sans rien perdre.
    if (convId !== this.affiche) this.#liberer(convId)
    else this.surEtat(convId, 'libre')

    this.#promouvoir()
  }

  #promouvoir(): void {
    while (this.occupes() < this.max && this.file.length) {
      const suivant = this.file[0]
      const f = this.fils.get(suivant)
      if (!f?.enAttente.length) { this.file.shift(); continue }
      const texte = f.enAttente.splice(0, f.enAttente.length).join('\n\n')
      tracer('fil sorti de la file', suivant)
      this.#lancer(suivant, texte)
    }
  }

  #liberer(convId: string): void {
    const f = this.fils.get(convId)
    if (!f) return
    try { f.session?.stop() } catch {}
    this.fils.delete(convId)
    this.file = this.file.filter((id) => id !== convId)
    this.surEtat(convId, 'libre')
  }

  // ------------------------------------------------------------- navigation

  /**
   * Change le fil regardé. Ne touche à rien d'autre : ce qui travaille continue.
   * L'ancien fil, s'il ne fait rien, rend son processus.
   */
  afficher(convId: string | null): void {
    const ancien = this.affiche
    this.affiche = convId
    if (ancien && ancien !== convId && this.etat(ancien) === 'libre') this.#liberer(ancien)
    if (convId) this.#entree(convId)
  }

  /** La session du fil regardé, prête à recevoir. Créée à la demande. */
  session(convId: string): SessionPilotable | null {
    return this.fils.get(convId)?.session || null
  }

  interrompre(convId: string): void {
    const f = this.fils.get(convId)
    if (!f?.occupe) return
    f.session?.interrupt()
  }

  /** Le fil est supprimé : on arrête tout et on oublie. */
  oublier(convId: string): void {
    const f = this.fils.get(convId)
    if (!f) return
    f.enAttente.length = 0
    this.#liberer(convId)
    this.#promouvoir()
  }

  setModel(model: string): void {
    for (const f of this.fils.values()) f.session?.setModel(model)
  }

  /** Redémarre tout le monde : les règles ont changé sous leurs pieds. */
  toutArreter(): void {
    for (const id of [...this.fils.keys()]) this.#liberer(id)
    this.file = []
  }
}
