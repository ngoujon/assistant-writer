import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSystemPrompt } from './prompt.mjs'
import { GardeRedaction } from './gardes.mjs'
import { resumerPermission } from './resume.mjs'
import { serveurRedacteur } from './outils.mjs'
import { listerDocuments } from '../doc/bibliotheque.mjs'
import { P } from '../doc/paths.mjs'
import { tracer } from '../doc/journal.mjs'

const HOME = os.homedir()
const require = createRequire(import.meta.url)

/** Une app lancée depuis le Dock n'hérite pas du PATH du shell. */
const PATH_SUP = [
  path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin',
  '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
]

// Le SDK embarque son binaire Claude Code et le résout par chemin de module.
// Ce repli ne sert que si le paquet natif manque (installation partielle).
function claudeExecutable() {
  try {
    require.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json')
    return undefined
  } catch {}
  for (const c of [path.join(HOME, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    try { fs.accessSync(c, fs.constants.X_OK); return c } catch {}
  }
  return undefined
}

const PREFIXE = 'mcp__redacteur__'

/**
 * Les outils de rédaction portent eux-mêmes leur politique de validation (voir
 * outils.mjs) : ils savent quel document est en jeu et n'interrompent Nicolas que
 * pour une réécriture ou une suppression. On ne les double pas d'une confirmation
 * générique — enregistrer un document, c'est exactement ce qu'on leur demande.
 */
const BUILTIN_SUR = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'TodoWrite', 'Task',
  'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
  'Skill', 'AskUserQuestion', 'TaskOutput',
])

function fileEntree() {
  const attente = []
  let dormeur = null
  let ferme = false
  return {
    push(msg) {
      if (dormeur) { const d = dormeur; dormeur = null; d({ value: msg, done: false }) }
      else attente.push(msg)
    },
    close() {
      ferme = true
      if (dormeur) { const d = dormeur; dormeur = null; d({ done: true }) }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (attente.length) { yield attente.shift(); continue }
        if (ferme) return
        const r = await new Promise((res) => { dormeur = res })
        if (r.done) return
        yield r.value
      }
    },
  }
}

export class AgentSession {
  constructor({ emit, askPermission, getConfig, ouvrirFichier, envoyerCorbeille }) {
    this.emit = emit
    this.askPermission = askPermission
    this.getConfig = getConfig
    this.ouvrirFichier = ouvrirFichier || (() => {})
    this.envoyerCorbeille = envoyerCorbeille || (async () => false)
    this.q = null
    this.queue = null
    this.abort = null
    this.sessionId = null
    this.busy = false
    this.streamed = new Set()
    this.toolNames = new Map()
    this.garde = new GardeRedaction()
    this.minuteurConnexion = null
    /** Nombre de rebranchements automatiques déjà tentés. */
    this.repriseAuto = 0
  }

  get running() { return this.q !== null }

  buildOptions(resume) {
    const cfg = this.getConfig()
    const bin = claudeExecutable()
    return {
      // La bibliothèque est le dossier courant : Read, Glob et Grep y tombent
      // naturellement sur les documents déjà écrits.
      cwd: P.bibliotheque(),
      additionalDirectories: [HOME],
      model: cfg.model,
      effort: 'high',
      thinking: { type: 'adaptive', display: 'summarized' },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildSystemPrompt({
          bibliotheque: P.bibliotheque(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          profondeur: cfg.profondeur,
          langue: cfg.langue,
          documents: listerDocuments(),
        }),
      },
      // Pas de WebFetch : toute lecture de page passe par `consulter_source`, qui
      // inscrit la page au registre. C'est ce qui rend la bibliographie honnête.
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'TodoWrite', 'Task'],
      strictMcpConfig: true,
      mcpServers: {
        redacteur: serveurRedacteur({
          confirmer: (d) => this.confirmerAction(d),
          signaler: (evt) => this.emit(evt),
          ouvrir: (chemin) => this.ouvrirFichier(chemin),
          titrer: (titre) => this.emit({ k: 'titre', titre }),
          corbeille: (chemin) => this.envoyerCorbeille(chemin),
          ouvrirAuto: () => this.getConfig()?.ouvrirAuto !== false,
          modele: () => this.getConfig()?.model,
        }),
      },
      // Aucune source de réglages externe : les règles d'autorisation de cette app
      // ne doivent pas pouvoir être élargies par un settings.json global.
      settingSources: [],
      permissionMode: 'default',
      hooks: this.garde.hooks(),
      includePartialMessages: true,
      abortController: this.abort,
      resume: resume || undefined,
      title: 'Assistant Rédacteur',
      env: {
        ...process.env,
        PATH: [...new Set([...PATH_SUP, ...(process.env.PATH || '').split(':')])].filter(Boolean).join(':'),
        CLAUDE_AGENT_SDK_CLIENT_APP: 'assistant-redacteur/1.0.0',
      },
      ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
      // La sortie d'erreur de Claude Code va au journal : c'est là qu'on lit
      // pourquoi une session ne démarre pas quand l'app est lancée depuis le Dock.
      stderr: (d) => {
        tracer('[claude]', String(d).trimEnd().slice(0, 500))
        if (process.env.REDACTEUR_DEBUG) process.stderr.write(`[claude] ${d}`)
      },
      canUseTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts),
    }
  }

  start({ resume } = {}) {
    this.stop()
    this.abort = new AbortController()
    this.queue = fileEntree()
    this.sessionId = null
    this.resumeId = resume || null
    this.streamed = new Set()
    this.garde = new GardeRedaction()
    const options = this.buildOptions(resume)
    tracer('session start | cwd', options.cwd, '| modèle', options.model, '| reprise', resume || 'non',
      '| binaire', options.pathToClaudeCodeExecutable || 'embarqué')
    this.q = query({ prompt: this.queue, options })
    // Pas de « connexion en cours » ici : en entrée continue, Claude Code ne dit
    // rien — pas même son message d'initialisation — tant qu'il n'a pas reçu une
    // première demande. Annoncer une connexion qui n'aura lieu qu'au premier
    // message laisserait un voyant d'attente allumé pour rien.
    this.emit({ k: 'status', state: 'idle' })
    this.pump()
  }

  async pump() {
    const courant = this.q
    try {
      for await (const msg of courant) {
        if (this.q !== courant) break
        this.route(msg)
      }
    } catch (err) {
      if (this.q !== courant) return
      if (this.abort?.signal.aborted) return
      this.busy = false
      tracer('session erreur', String(err?.stack || err?.message || err).slice(0, 700))

      if (this.resumeId) {
        this.resumeId = null
        this.emit({ k: 'note', text: 'Conversation précédente introuvable, on repart à zéro.' })
        this.start({})
        return
      }

      // Claude Code s'est arrêté en cours de route. Son contexte, lui, est
      // enregistré : on rebranche dessus tout de suite, pour que le travail soit
      // reprenable au lieu d'être perdu. On ne le refait qu'un nombre limité de
      // fois — s'acharner sur une panne de fond ne ferait que boucler.
      const perdu = this.sessionId
      if (perdu && this.repriseAuto < 2) {
        this.repriseAuto += 1
        this.emit({ k: 'note', text: "L'assistant s'est arrêté en cours de route. Je rebranche la conversation." })
        this.start({ resume: perdu })
        this.emit({ k: 'reprise-possible' })
        return
      }

      this.emit({ k: 'error', message: String(err?.message || err) })
      this.emit({ k: 'status', state: 'idle' })
    }
  }

  /**
   * Claude Code lit ses identifiants dans le trousseau macOS. À la première
   * ouverture d'une nouvelle version signée, le système pose une question — et
   * tant qu'on ne répond pas, rien n'arrive. La boîte de dialogue passe souvent
   * derrière la fenêtre : mieux vaut le dire que laisser tourner « Connexion… ».
   */
  armerAttente() {
    if (this.sessionId) return
    clearTimeout(this.minuteurConnexion)
    this.minuteurConnexion = setTimeout(() => {
      if (this.sessionId) return
      tracer('connexion sans réponse après 30 s')
      this.emit({
        k: 'note',
        text: "Toujours en connexion… macOS demande peut-être l'autorisation d'accéder au trousseau "
          + '(identifiants Claude Code). Cherche la boîte de dialogue derrière la fenêtre et choisis '
          + '« Toujours autoriser ».',
      })
    }, 30000)
  }

  stop() {
    clearTimeout(this.minuteurConnexion)
    try { this.queue?.close() } catch {}
    try { this.abort?.abort() } catch {}
    this.q = null
    this.queue = null
    this.busy = false
  }

  /**
   * Envoie un message. Si un tour est déjà en cours, le message rejoint la file
   * d'entrée : le SDK le remet au modèle à la prochaine respiration, qui refait
   * son plan avec. On ne bloque donc jamais la saisie.
   */
  send(text) {
    this.repriseAuto = 0
    if (!this.q) this.start({})
    // C'est maintenant que la session s'ouvre vraiment, et donc maintenant que
    // macOS peut demander l'accès au trousseau : on surveille à partir d'ici.
    this.armerAttente()
    const enCours = this.busy
    this.busy = true
    this.emit({ k: enCours ? 'queued' : 'turn-start' })
    this.emit({ k: 'status', state: 'thinking' })
    this.pousser(text)
  }

  pousser(text) {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    })
  }

  async interrupt() {
    if (!this.q || !this.busy) return
    try { await this.q.interrupt() } catch {}
    this.busy = false
    this.emit({ k: 'interrupted' })
    this.emit({ k: 'status', state: 'idle' })
  }

  async setModel(model) {
    if (this.q) { try { await this.q.setModel(model) } catch {} }
  }

  // ---------------------------------------------------------------- routage

  route(msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          clearTimeout(this.minuteurConnexion)
          this.sessionId = msg.session_id
          const srv = (msg.mcp_servers || []).find((s) => s.name === 'redacteur')
          this.emit({ k: 'ready', sessionId: msg.session_id, model: msg.model, outils: srv?.status || 'absent' })
          if (this.resumeId) this.emit({ k: 'resumed' })
          this.emit({ k: 'status', state: this.busy ? 'thinking' : 'idle' })
        } else if (msg.subtype === 'compact_boundary') {
          this.emit({ k: 'note', text: 'Conversation résumée pour libérer de la mémoire.' })
        }
        break

      case 'stream_event': {
        const ev = msg.event
        if (ev.type === 'message_start' && ev.message?.id) this.streamed.add(ev.message.id)
        if (ev.type === 'content_block_start') {
          if (ev.content_block?.type === 'text') this.emit({ k: 'text-start' })
          if (ev.content_block?.type === 'thinking') this.emit({ k: 'thinking-start' })
        }
        if (ev.type === 'content_block_delta') {
          const d = ev.delta
          if (d.type === 'text_delta' && d.text) this.emit({ k: 'text-delta', text: d.text })
          if (d.type === 'thinking_delta' && d.thinking) this.emit({ k: 'thinking-delta', text: d.thinking })
        }
        break
      }

      case 'assistant': {
        const id = msg.message?.id
        const dejaVu = id && this.streamed.has(id)
        for (const bloc of msg.message?.content || []) {
          if (bloc.type === 'tool_use') {
            this.toolNames.set(bloc.id, bloc.name)
            this.emit({ k: 'tool-use', id: bloc.id, name: bloc.name, input: bloc.input })
          } else if (bloc.type === 'text' && !dejaVu && bloc.text?.trim()) {
            this.emit({ k: 'text-start' })
            this.emit({ k: 'text-delta', text: bloc.text })
          }
        }
        break
      }

      case 'user': {
        const contenu = msg.message?.content
        if (!Array.isArray(contenu)) break
        for (const bloc of contenu) {
          if (bloc.type !== 'tool_result') continue
          const nom = this.toolNames.get(bloc.tool_use_id) || ''
          const brut = textOf(bloc.content)
          this.garde.noteToolResult(nom, brut)
          this.emit({ k: 'tool-result', id: bloc.tool_use_id, name: nom, ok: !bloc.is_error, preview: tronquer(brut) })
        }
        break
      }

      case 'result':
        this.busy = false
        this.emit({
          k: 'result',
          isError: msg.subtype !== 'success',
          text: msg.subtype !== 'success' ? raisonArret(msg) : '',
          reprenable: msg.subtype !== 'success',
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
        })
        this.emit({ k: 'status', state: 'idle' })
        break
    }
  }

  // ------------------------------------------------------------ permissions

  /**
   * Validation demandée par un outil de rédaction, une fois qu'il sait exactement
   * quel document est en jeu.
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
   * L'assistant travaille-t-il seul ? Réglable dans la fenêtre ; autonome par
   * défaut, parce qu'une recherche qui s'arrête pour poser une question à
   * laquelle Nicolas a déjà répondu en formulant sa demande ne sert à rien.
   *
   * Ce réglage ne touche qu'aux validations. Les garde-fous de rédaction — on ne
   * cite que ce qu'on a lu — sont des règles, pas des permissions : ils
   * s'appliquent dans les deux modes.
   */
  autonome() {
    return (this.getConfig()?.autonomie || 'auto') === 'auto'
  }

  async handlePermission(toolName, input, opts) {
    // Outils de rédaction : la décision appartient à l'outil, qui la prend en
    // connaissance de cause. Redemander ici ferait valider deux fois la même action.
    if (toolName.startsWith(PREFIXE)) return { behavior: 'allow', updatedInput: input }
    if (BUILTIN_SUR.has(toolName)) return { behavior: 'allow', updatedInput: input }

    if (this.autonome()) {
      tracer('autonomie — outil autorisé sans demander :', toolName, argLisible(input))
      return { behavior: 'allow', updatedInput: input }
    }

    const summary = resumerPermission(toolName, input)
    const reponse = await this.askPermission({
      toolName,
      input,
      summary,
      title: summary?.title || opts?.title,
      displayName: opts?.displayName,
      subtitle: opts?.subtitle,
      reason: opts?.decisionReason,
      allowAlways: true,
      signal: opts?.signal,
    })

    if (reponse?.behavior === 'allow') {
      const res = { behavior: 'allow', updatedInput: input }
      if (reponse.always && opts?.suggestions?.length) res.updatedPermissions = opts.suggestions
      return res
    }
    return { behavior: 'deny', message: reponse?.message || 'Refusé par Nicolas.' }
  }
}

/**
 * Un tour qui s'arrête avant la fin doit le dire en français, et dire quoi faire.
 * Les libellés bruts du SDK sont anglais et techniques : ils n'ont rien à faire
 * dans la fenêtre.
 */
const ARRETS = {
  error_max_turns: "J'ai atteint la limite d'étapes pour ce message — le travail n'est pas terminé.",
  error_max_tokens: 'La réponse est devenue trop longue pour tenir en une fois.',
  error_during_execution: "Le tour s'est interrompu avant la fin.",
}

function raisonArret(msg) {
  const connu = ARRETS[msg.subtype]
  if (connu) return `${connu} Clique « Continuer » ou écris « continue » : je reprends où j'en étais.`
  const brut = String(msg.result || msg.subtype || '').trim()
  return brut
    ? `Le tour s'est arrêté avant la fin : ${brut}`
    : "Le tour s'est arrêté avant la fin, sans raison précisée."
}

/** Un aperçu d'entrée d'outil pour le journal : une ligne, pas un déversement. */
function argLisible(input) {
  if (!input || typeof input !== 'object') return ''
  for (const cle of ['command', 'file_path', 'nom', 'url', 'titre']) {
    if (typeof input[cle] === 'string' && input[cle]) return input[cle].slice(0, 160)
  }
  return ''
}

function textOf(contenu) {
  if (typeof contenu === 'string') return contenu
  if (Array.isArray(contenu)) return contenu.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  return ''
}

function tronquer(s, n = 700) {
  if (!s) return ''
  const t = String(s).trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
