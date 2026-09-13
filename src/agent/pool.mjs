// Plusieurs conversations qui travaillent en même temps.
//
// Une session = une conversation avec le modèle local. On en laisse deux tourner de
// front : au-delà, la machine qui héberge le modèle sature et les deux recherches
// avancent moins vite que si elles s'étaient suivies. Les demandes suivantes attendent
// leur tour, et partent dès qu'une place se libère.
//
// Le point important : **naviguer n'interrompt rien**. Changer de conversation ne
// fait que changer ce qu'on regarde ; ce qui tourne continue de tourner, et son
// fil se remplit en arrière-plan.
import { tracer } from '../doc/journal.mjs'

export const MAX_EN_PARALLELE = 2

export class Pool {
  /**
   * @param {object} o
   * @param {(convId: string) => object} o.creerSession fabrique une session branchée sur ce fil
   * @param {(convId: string) => string|undefined} o.repriseDe identifiant de session à reprendre
   * @param {(convId: string, etat: string) => void} o.surEtat prévient d'un changement d'état
   * @param {number} [o.max]
   */
  constructor({ creerSession, repriseDe, surEtat, max = MAX_EN_PARALLELE }) {
    this.creerSession = creerSession
    this.repriseDe = repriseDe || (() => undefined)
    this.surEtat = surEtat || (() => {})
    this.max = max
    /** convId -> { session, occupe, enAttente: string[] } */
    this.fils = new Map()
    /** Ordre d'arrivée des fils qui attendent une place. */
    this.file = []
    /** Le fil affiché : sa session reste chaude, pour que la frappe réponde tout de suite. */
    this.affiche = null
  }

  // ------------------------------------------------------------------ états

  /** `travaille` (un tour est en cours), `attend` (une place se libère), ou `libre`. */
  etat(convId) {
    const f = this.fils.get(convId)
    if (f?.occupe) return 'travaille'
    if (f?.enAttente.length) return 'attend'
    return 'libre'
  }

  etats() {
    const out = new Map()
    for (const [id] of this.fils) out.set(id, this.etat(id))
    return out
  }

  occupes() {
    let n = 0
    for (const f of this.fils.values()) if (f.occupe) n += 1
    return n
  }

  #entree(convId) {
    if (!this.fils.has(convId)) this.fils.set(convId, { session: null, occupe: false, enAttente: [] })
    return this.fils.get(convId)
  }

  #demarrer(convId) {
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
   * @returns {'envoye'|'attente'}
   */
  envoyer(convId, texte) {
    const f = this.#entree(convId)

    if (f.occupe) {
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

  #lancer(convId, texte) {
    const f = this.#entree(convId)
    this.#demarrer(convId)
    f.occupe = true
    this.file = this.file.filter((id) => id !== convId)
    f.session.send(texte)
    this.surEtat(convId, 'travaille')
  }

  /** Un tour vient de se terminer : on libère la place et on fait avancer la file. */
  finDeTour(convId) {
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

  #promouvoir() {
    while (this.occupes() < this.max && this.file.length) {
      const suivant = this.file[0]
      const f = this.fils.get(suivant)
      if (!f?.enAttente.length) { this.file.shift(); continue }
      const texte = f.enAttente.splice(0, f.enAttente.length).join('\n\n')
      tracer('fil sorti de la file', suivant)
      this.#lancer(suivant, texte)
    }
  }

  #liberer(convId) {
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
  afficher(convId) {
    const ancien = this.affiche
    this.affiche = convId
    if (ancien && ancien !== convId && this.etat(ancien) === 'libre') this.#liberer(ancien)
    if (convId) this.#entree(convId)
  }

  /** La session du fil regardé, prête à recevoir. Créée à la demande. */
  session(convId) {
    return this.fils.get(convId)?.session || null
  }

  interrompre(convId) {
    const f = this.fils.get(convId)
    if (!f?.occupe) return
    f.session?.interrupt()
  }

  /** Le fil est supprimé : on arrête tout et on oublie. */
  oublier(convId) {
    const f = this.fils.get(convId)
    if (!f) return
    f.enAttente.length = 0
    this.#liberer(convId)
    this.#promouvoir()
  }

  setModel(model) {
    for (const f of this.fils.values()) f.session?.setModel(model)
  }

  /** Redémarre tout le monde : les règles ont changé sous leurs pieds. */
  toutArreter() {
    for (const id of [...this.fils.keys()]) this.#liberer(id)
    this.file = []
  }
}
