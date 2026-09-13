// Une conversation avec le modèle local.
//
// C'était un sous-processus Claude Code piloté par le SDK d'Anthropic ; c'est
// maintenant une boucle écrite ici, qui parle à un serveur compatible OpenAI sur le
// réseau de Nicolas (voir moteur.mjs). Le contrat vers la fenêtre n'a pas bougé d'un
// pouce : ce sont les mêmes événements (`text-delta`, `tool-use`, `document`…), donc
// le même affichage, les mêmes conversations enregistrées.
//
// Ce que la boucle ajoute, et que le SDK faisait pour nous :
//   — elle tient l'historique des messages et le **rogne** pour tenir dans la fenêtre
//     du modèle local, qui est petite (16 k jetons là où un modèle distant en a 200 k) ;
//   — elle applique les garde-fous avant chaque outil, au lieu de passer par des hooks ;
//   — elle décide quand un tour est fini : plus personne ne nous envoie de « result ».
import { completer, contexteDe, joignable, estimerJetons, jetonsMessage, racine, SERVEUR_DEFAUT, CONTEXTE_DEFAUT } from './moteur.mjs'
import { buildSystemPrompt } from './prompt.mjs'
import { GardeRedaction } from './gardes.mjs'
import { outilsRedacteur } from './outils.mjs'
import { listerDocuments } from '../doc/bibliotheque.mjs'
import { P } from '../doc/paths.mjs'
import { tracer } from '../doc/journal.mjs'

/** Garde-fou contre une boucle d'outils qui ne s'arrêterait jamais. */
const MAX_ETAPES = 60

/**
 * En dessous, on prévient Nicolas : les consignes, les pages lues et le document à
 * écrire doivent tenir ensemble dans la fenêtre du modèle, et un modèle qui réfléchit
 * avant d'appeler un outil dépense encore de la place là-dedans.
 */
const FENETRE_CONFORTABLE = 24000

/**
 * Ce qu'on laisse au modèle pour écrire sa réponse, en jetons.
 *
 * Généreux, parce que la réponse la plus importante de cette application est un
 * document entier passé en argument d'outil : trop serré, il est coupé au milieu
 * d'une phrase — et un appel d'outil coupé ne s'exécute pas. C'est le tiers de la
 * fenêtre, ce qui laisse les deux autres tiers aux sources et à la conversation.
 */
function budgetSortie(contexte) {
  return Math.min(8192, Math.max(1536, Math.floor(contexte / 3)))
}

export class AgentSession {
  constructor({
    emit, askPermission, getConfig, ouvrirFichier, envoyerCorbeille,
    chargerHistorique, enregistrerHistorique,
  }) {
    this.emit = emit
    this.askPermission = askPermission
    this.getConfig = getConfig
    this.ouvrirFichier = ouvrirFichier || (() => {})
    this.envoyerCorbeille = envoyerCorbeille || (async () => false)
    this.chargerHistorique = chargerHistorique || (() => [])
    this.enregistrerHistorique = enregistrerHistorique || (() => {})

    /** L'historique au format du serveur : le message système n'y est pas. */
    this.messages = []
    /** Ce que Nicolas a écrit pendant que le modèle travaillait. */
    this.enAttente = []
    this.abort = null
    this.sessionId = null
    this.busy = false
    this.vivante = false
    this.garde = new GardeRedaction()
    this.contexte = 0
    this.outils = null
    /** Un document est-il déjà sorti de cette conversation ? Voir #relancerLaPublication. */
    this.aPublie = false
  }

  get running() { return this.vivante }

  // ------------------------------------------------------------- cycle de vie

  start({ resume } = {}) {
    this.stop()
    this.abort = new AbortController()
    this.garde = new GardeRedaction()
    this.aPublie = false
    this.messages = []
    this.enAttente = []
    this.vivante = true
    this.sessionId = resume || `loc-${Date.now().toString(36)}`
    this.outils = this.construireOutils()

    if (resume) {
      const repris = this.chargerHistorique(resume)
      if (Array.isArray(repris) && repris.length) {
        this.messages = repris
        // Les sources lues avant la coupure comptent comme lues : sans ça, le
        // garde-fou refuserait de citer ce que la conversation vient d'ouvrir.
        for (const m of repris) {
          if (m.role === 'tool') this.garde.noteToolResult(m.name || '', m.content || '')
          if (m.role === 'assistant') {
            for (const a of m.tool_calls || []) if (a.function?.name === 'rediger_document') this.aPublie = true
          }
        }
        this.emit({ k: 'resumed' })
      }
    }

    const cfg = this.getConfig() || {}
    tracer('session locale', this.sessionId, '| serveur', racine(cfg.serveur), '| modèle', cfg.model,
      '| reprise', resume || 'non', '| messages repris', this.messages.length)

    this.emit({ k: 'ready', sessionId: this.sessionId, model: cfg.model, outils: 'connected' })
    this.emit({ k: 'status', state: 'idle' })
    this.verifierServeur()
  }

  /** Le serveur répond-il, et connaît-il le modèle demandé ? On le dit tout de suite. */
  async verifierServeur() {
    const cfg = this.getConfig() || {}
    const base = cfg.serveur || SERVEUR_DEFAUT
    const vu = await joignable(base)
    if (!this.vivante) return
    if (!vu) {
      this.emit({
        k: 'note',
        text: `Le serveur local ne répond pas (${racine(base)}). Démarre le serveur dans LM Studio, ou corrige `
          + "l'adresse dans les réglages.",
        kind: 'err',
      })
      return
    }
    this.contexte = await contexteDe(base, cfg.model) || 0
    if (!this.vivante || !this.contexte) return
    tracer('fenêtre de contexte', this.contexte, 'jetons')

    // Une fenêtre étroite ne casse rien — l'app rogne et publie par tranches — mais
    // elle bride vraiment le travail : le modèle doit y faire tenir les consignes, les
    // pages lues ET le document qu'il écrit. Autant le dire, avec le geste qui règle
    // le problème, plutôt que de laisser Nicolas attribuer la lenteur à l'application.
    if (this.contexte < FENETRE_CONFORTABLE) {
      this.emit({
        k: 'note',
        text: `Fenêtre de contexte de ${this.contexte.toLocaleString('fr-FR')} jetons : c'est court pour rédiger un `
          + 'document sourcé. Je publierai par tranches (une version resserrée, puis des enrichissements). '
          + 'Pour des documents plus complets : dans LM Studio, recharge le modèle avec « Context Length » à '
          + '32 768 ou plus.',
      })
    }
  }

  stop() {
    this.vivante = false
    try { this.abort?.abort() } catch {}
    this.busy = false
    this.enAttente = []
  }

  async interrupt() {
    if (!this.vivante || !this.busy) return
    // On laisse le contrôleur avorté en place : c'est à lui que la boucle reconnaît
    // qu'elle a été arrêtée exprès, et non qu'elle est tombée en panne. Le prochain
    // envoi en fabrique un neuf.
    try { this.abort?.abort() } catch {}
    this.busy = false
    this.enAttente = []
    this.emit({ k: 'interrupted' })
    this.emit({ k: 'status', state: 'idle' })
  }

  async setModel() {
    // Le modèle est relu à chaque tour dans les réglages : il n'y a rien à pousser
    // au serveur. On oublie juste la taille de fenêtre du modèle précédent.
    this.contexte = 0
    const cfg = this.getConfig() || {}
    this.contexte = await contexteDe(cfg.serveur || SERVEUR_DEFAUT, cfg.model) || 0
  }

  // ------------------------------------------------------------------- envoi

  /**
   * Envoie une demande. Si un tour est déjà en cours, elle rejoint la file : le
   * modèle la prendra à sa prochaine respiration, entre deux outils. On ne bloque
   * donc jamais la saisie.
   */
  send(text) {
    if (!this.vivante) this.start({})
    const enCours = this.busy
    if (!enCours && this.abort?.signal.aborted) this.abort = new AbortController()
    this.enAttente.push(String(text))
    this.emit({ k: enCours ? 'queued' : 'turn-start' })
    this.emit({ k: 'status', state: 'thinking' })
    if (!enCours) this.boucler()
  }

  /** Fait passer dans l'historique ce que Nicolas a écrit depuis la dernière étape. */
  #absorberAttente() {
    if (!this.enAttente.length) return false
    for (const t of this.enAttente.splice(0, this.enAttente.length)) {
      this.messages.push({ role: 'user', content: t })
    }
    return true
  }

  // -------------------------------------------------------------- la boucle

  async boucler() {
    this.busy = true
    const cfg = () => this.getConfig() || {}
    let etapes = 0
    /** Tours vides d'affilée : un modèle local en produit parfois un, sans raison. */
    let vides = 0
    let arret = { isError: false, text: '' }
    const debut = Date.now()

    try {
      while (this.vivante) {
        this.#absorberAttente()
        if (etapes >= MAX_ETAPES) {
          arret = {
            isError: true,
            text: "J'ai atteint la limite d'étapes pour ce message — le travail n'est pas terminé. "
              + 'Écris « continue » : je reprends où j\'en étais.',
          }
          break
        }
        etapes += 1

        const c = cfg()
        const contexte = this.contexte || CONTEXTE_DEFAUT
        const sortie = budgetSortie(contexte)
        const messages = this.#fenetre(contexte - sortie)

        let debutTexte = false
        let debutPensee = false
        const reponse = await completer({
          base: c.serveur || SERVEUR_DEFAUT,
          modele: c.model,
          messages,
          outils: this.outils.definitions,
          signal: this.abort.signal,
          maxJetons: sortie,
          temperature: 0.3,
          // Réglable surtout pour les tests : au-delà de ce silence, on rend la main
          // au lieu de laisser la fenêtre « en réflexion » indéfiniment.
          ...(c.inactiviteMs ? { inactivite: c.inactiviteMs } : {}),
          surTexte: (t) => {
            if (!debutTexte) { debutTexte = true; this.emit({ k: 'text-start' }) }
            this.emit({ k: 'text-delta', text: t })
          },
          surPensee: (t) => {
            if (!debutPensee) { debutPensee = true; this.emit({ k: 'thinking-start' }) }
            this.emit({ k: 'thinking-delta', text: t })
          },
        })

        if (!this.vivante) return

        const bruts = reponse.appels.length ? reponse.appels : appelsDansLeTexte(reponse.texte)
        // On analyse les arguments AVANT de remettre l'appel dans l'historique : un
        // serveur local refuse tout le dialogue si on lui renvoie du JSON qu'il ne
        // sait pas relire — et c'est exactement ce qu'il vient de produire quand sa
        // réponse a été coupée.
        const appels = bruts.map((a) => ({ ...a, ...lireArguments(a.args) }))
        const message = { role: 'assistant', content: reponse.texte || '' }
        if (appels.length) {
          message.tool_calls = appels.map((a) => ({
            id: a.id, type: 'function', function: { name: a.nom, arguments: JSON.stringify(a.args || {}) },
          }))
        }
        this.messages.push(message)

        // Réponse coupée en plein appel d'outil : les arguments sont incomplets.
        // L'exécuter écrirait un document tronqué — on le dit au modèle à la place.
        if (appels.length && reponse.raison === 'length') {
          for (const appel of appels) this.#couper(appel)
          this.#enregistrer()
          continue
        }

        if (!appels.length) {
          // Rien à faire de plus : si Nicolas a écrit entre-temps, on repart pour un
          // tour avec sa demande ; sinon le tour est fini.
          if (this.enAttente.length) continue
          if (reponse.raison === 'length') {
            arret = { isError: true, text: 'La réponse est devenue trop longue pour tenir en une fois.' }
          } else if (!reponse.texte.trim()) {
            // Un tour vide : le modèle a parfois « pensé » sans rien dire, surtout
            // quand la conversation s'allonge. On le relance une ou deux fois — c'est
            // presque toujours suffisant — avant de constater la panne.
            vides += 1
            if (vides <= 2) {
              tracer('tour vide, relance', vides)
              this.messages.push({
                role: 'user',
                content: '[Ta dernière réponse était vide. Reprends : appelle un outil, ou réponds en français.]',
              })
              continue
            }
            arret = {
              isError: true,
              text: "Le modèle n'a rien répondu, trois fois de suite. Vérifie qu'il sait appeler des outils "
                + "(LM Studio l'indique sur la fiche du modèle), qu'il est bien chargé, et que sa fenêtre de "
                + 'contexte est assez large.',
            }
          }
          break
        }

        vides = 0
        for (const appel of appels) {
          // Une interruption arrivée pendant un outil arrête aussi les suivants.
          if (!this.vivante || this.abort?.signal.aborted) return
          await this.#executer(appel)
        }
        this.#enregistrer()
      }
    } catch (err) {
      if (!this.vivante) return
      if (this.abort?.signal.aborted) { this.busy = false; return }
      tracer('erreur de session', String(err?.stack || err?.message || err).slice(0, 600))
      this.emit({ k: 'error', message: String(err?.message || err) })
      arret = { isError: true, text: String(err?.message || err) }
    }

    this.busy = false
    this.#enregistrer()
    this.emit({
      k: 'result',
      isError: arret.isError,
      text: arret.text,
      reprenable: arret.isError,
      durationMs: Date.now() - debut,
    })
    this.emit({ k: 'status', state: 'idle' })

    // Une demande arrivée pendant la toute fin du tour ne doit pas rester en plan.
    if (this.vivante && this.enAttente.length) {
      this.emit({ k: 'turn-start' })
      this.emit({ k: 'status', state: 'thinking' })
      this.boucler()
    }
  }

  /**
   * Un appel d'outil arrivé en morceaux : la réponse du modèle a atteint sa limite
   * de longueur au milieu. On rend la main au modèle avec de quoi recommencer plus
   * court, plutôt que d'enregistrer un document coupé en pleine phrase.
   */
  #couper(appel) {
    this.emit({ k: 'tool-use', id: appel.id, name: appel.nom, input: appel.args || {} })
    const texte = 'REFUSÉ : ta réponse a atteint sa longueur maximale avant la fin de cet appel — les arguments '
      + 'sont incomplets, rien n\'a été exécuté. Recommence en plus court : pour un document, publie d\'abord '
      + 'une version resserrée (les sections essentielles), tu l\'enrichiras ensuite par une nouvelle version.'
    this.messages.push({ role: 'tool', tool_call_id: appel.id, name: appel.nom, content: texte })
    this.emit({ k: 'tool-result', id: appel.id, name: appel.nom, ok: false, preview: texte })
    tracer('appel coupé par la limite de longueur :', appel.nom)
  }

  /** Exécute un appel d'outil : garde-fou, exécution, compte rendu au modèle. */
  async #executer(appel) {
    const nom = appel.nom
    const { args, erreur } = appel

    this.emit({ k: 'tool-use', id: appel.id, name: nom, input: args })

    let resultat
    if (erreur) {
      resultat = {
        texte: `ERREUR : arguments illisibles (${erreur}). Rappelle l'outil avec un objet JSON valide.`,
        erreur: true,
      }
    } else {
      const refus = this.garde.verifier(nom, args)
      if (refus) {
        tracer('garde-fou', nom, '→', refus.slice(0, 160))
        resultat = { texte: `REFUSÉ : ${refus}`, erreur: true }
      } else {
        resultat = await this.outils.executer(nom, args)
      }
    }

    this.garde.noteToolResult(nom, resultat.texte)
    this.#relancerLaPublication(nom, resultat)
    this.messages.push({ role: 'tool', tool_call_id: appel.id, name: nom, content: resultat.texte })
    this.emit({
      k: 'tool-result',
      id: appel.id,
      name: nom,
      ok: !resultat.erreur,
      preview: tronquer(resultat.texte),
    })
  }

  /**
   * Publier tôt, pour de vrai.
   *
   * Les consignes le demandent, mais un modèle local lit volontiers dix pages avant
   * d'écrire une ligne — et sur une machine personnelle, dix pages, c'est un quart
   * d'heure. Le rappel est donc posé là où il décide de la suite : dans le résultat
   * même de la lecture, juste avant qu'il choisisse quoi faire.
   */
  #relancerLaPublication(nom, resultat) {
    if (this.aPublie || resultat.erreur || nom !== 'consulter_source') return
    const lues = this.garde.luesIci.size
    if (lues < 4) return
    resultat.texte += `\n\nRAPPEL DE L'APPLICATION : ${lues} sources lues et rien de publié. `
      + 'Appelle `rediger_document` MAINTENANT pour publier une première version, même incomplète — '
      + 'tu continueras à l\'enrichir ensuite, chaque appel créant une version de plus. Une recherche '
      + "interrompue avant sa première publication ne laisse rien à Nicolas."
  }

  // ------------------------------------------------------------- le contexte

  /**
   * Les messages envoyés au modèle, taillés pour sa fenêtre.
   *
   * On garde toujours les consignes et la fin de la conversation — c'est là qu'est le
   * travail en cours. Ce qu'on sacrifie d'abord, ce sont les vieux résultats d'outils :
   * une page lue il y a dix étapes est déjà au registre, et `relire_source` la
   * rouvrira si besoin. Puis, s'il le faut encore, les plus anciens échanges.
   */
  #fenetre(budget) {
    const systeme = { role: 'system', content: this.#consignes() }
    const dispo = Math.max(1500, budget - estimerJetons(systeme.content) - 64
      - estimerJetons(JSON.stringify(this.outils.definitions)))

    const copie = this.messages.map((m) => ({ ...m }))
    let total = copie.reduce((n, m) => n + jetonsMessage(m), 0)

    // 1. Les vieux résultats d'outils rétrécissent, du plus ancien au plus récent.
    for (let i = 0; i < copie.length - 6 && total > dispo; i += 1) {
      const m = copie[i]
      if (m.role !== 'tool' || (m.content || '').length < 400) continue
      const avant = jetonsMessage(m)
      m.content = `${String(m.content).slice(0, 300)}\n…[résultat abrégé pour faire de la place ; `
        + 'rappelle l\'outil si tu as besoin du détail]'
      total -= avant - jetonsMessage(m)
    }

    // 2. Puis on coupe par le début, en emportant les résultats d'outils orphelins :
    //    un message `tool` sans son appel fait refuser la requête par le serveur.
    let debut = 0
    while (total > dispo && debut < copie.length - 2) {
      total -= jetonsMessage(copie[debut])
      debut += 1
      while (debut < copie.length && copie[debut].role === 'tool') {
        total -= jetonsMessage(copie[debut])
        debut += 1
      }
    }

    let gardes = copie.slice(debut)
    // Un `tool` en tête n'a plus son appel : on l'enlève.
    while (gardes.length && gardes[0].role === 'tool') gardes = gardes.slice(1)
    if (debut > 0) {
      gardes = [{
        role: 'user',
        content: '[Début de conversation retiré du contexte pour faire de la place. Le registre des sources '
          + '(`sources_consultees`) et la bibliothèque (`lister_documents`) gardent la trace du travail déjà fait.]',
      }, ...gardes]
    }

    return [systeme, ...gardes]
  }

  #consignes() {
    const cfg = this.getConfig() || {}
    return buildSystemPrompt({
      bibliotheque: P.bibliotheque(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      profondeur: cfg.profondeur,
      langue: cfg.langue,
      documents: listerDocuments(),
      horsLigne: !!cfg.horsLigne,
      fenetre: this.contexte || 0,
    })
  }

  #enregistrer() {
    try { this.enregistrerHistorique(this.sessionId, this.messages) } catch {}
  }

  // ------------------------------------------------------------------ outils

  construireOutils() {
    return outilsRedacteur({
      confirmer: (d) => this.confirmerAction(d),
      signaler: (evt) => {
        if (evt.k === 'document') this.aPublie = true
        this.emit(evt)
      },
      ouvrir: (chemin) => this.ouvrirFichier(chemin),
      titrer: (titre) => this.emit({ k: 'titre', titre }),
      corbeille: (chemin) => this.envoyerCorbeille(chemin),
      modele: () => this.getConfig()?.model,
      horsLigne: () => !!this.getConfig()?.horsLigne,
      searxng: () => this.getConfig()?.searxng || null,
      langue: () => this.getConfig()?.langue || 'français',
      limiteTexte: () => {
        const contexte = this.contexte || CONTEXTE_DEFAUT
        const entree = contexte - budgetSortie(contexte)
        // Un cinquième de la fenêtre d'entrée, en caractères : de quoi lire l'essentiel
        // d'un article sans effacer la conversation qui l'entoure — et sans allonger
        // chaque tour, car tout ce qu'on met là, le modèle le relit à chaque fois.
        // Une fenêtre plus large (réglable dans LM Studio) rallonge donc les extraits.
        return Math.min(14000, Math.max(1500, Math.round(entree * 3 * 0.2)))
      },
    })
  }

  // ------------------------------------------------------------- permissions

  /**
   * Validation demandée par un outil, une fois qu'il sait exactement quel document
   * est en jeu.
   * @returns {Promise<boolean>}
   */
  async confirmerAction(demande) {
    if (this.autonome()) {
      tracer('autonomie — action menée sans demander :', demande.outil, demande.titre)
      return true
    }
    const reponse = await this.askPermission({
      toolName: demande.outil,
      input: demande.entree,
      summary: { title: demande.titre, lines: demande.lignes, danger: demande.danger },
      title: demande.titre,
      hint: demande.indice,
      allowAlways: false,
      signal: this.abort?.signal,
    })
    return reponse?.behavior === 'allow'
  }

  /**
   * L'assistant travaille-t-il seul ? Réglable dans la fenêtre ; autonome par défaut,
   * parce qu'une recherche qui s'arrête pour poser une question à laquelle Nicolas a
   * déjà répondu en formulant sa demande ne sert à rien.
   *
   * Ce réglage ne touche qu'aux validations. Les garde-fous de rédaction — on ne cite
   * que ce qu'on a lu — sont des règles, pas des permissions : ils s'appliquent dans
   * les deux modes.
   */
  autonome() {
    return (this.getConfig()?.autonomie || 'auto') === 'auto'
  }
}

// ------------------------------------------------------------------ utilitaires

/**
 * Les arguments d'un appel d'outil, tels qu'un modèle local les écrit — c'est-à-dire
 * pas toujours du JSON strict. On rattrape ce qui se rattrape sans deviner : une
 * chaîne vide, des guillemets simples, une virgule en trop, un objet noyé dans du texte.
 */
export function lireArguments(brut) {
  const s = String(brut ?? '').trim()
  if (!s) return { args: {} }
  const essais = [
    s,
    s.replace(/,\s*([}\]])/g, '$1'),
    s.replace(/'/g, '"').replace(/,\s*([}\]])/g, '$1'),
    (s.match(/\{[\s\S]*\}/) || [])[0],
  ]
  for (const essai of essais) {
    if (!essai) continue
    try {
      const v = JSON.parse(essai)
      if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v }
    } catch {}
  }
  return { args: {}, erreur: s.slice(0, 120) }
}

/**
 * Certains modèles annoncent leurs outils en clair dans le texte au lieu d'utiliser le
 * mécanisme prévu. Plutôt que de laisser passer une réponse qui « raconte » un appel,
 * on le reconnaît et on l'exécute.
 */
export function appelsDansLeTexte(texte) {
  const out = []
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  let m
  while ((m = re.exec(String(texte || '')))) {
    try {
      const o = JSON.parse(m[1])
      const nom = o.name || o.nom || o.tool
      if (!nom) continue
      const args = o.arguments ?? o.args ?? o.parameters ?? {}
      out.push({
        id: `txt_${out.length}_${Date.now().toString(36)}`,
        nom: String(nom),
        args: typeof args === 'string' ? args : JSON.stringify(args),
      })
    } catch {}
  }
  return out
}

function tronquer(s, n = 700) {
  if (!s) return ''
  const t = String(s).trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
