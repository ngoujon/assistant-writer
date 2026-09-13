// Le moteur : un serveur compatible OpenAI posé sur le réseau de Nicolas.
//
// L'application parlait au SDK Claude — un binaire Claude Code lancé en sous-
// processus, qui appelait l'API d'Anthropic. Elle parle désormais à LM Studio (ou
// Ollama, ou llama.cpp) sur la machine ou sur le réseau local : aucune clé, aucun
// compte, aucun appel vers l'extérieur. Si le serveur répond, l'app fonctionne —
// avion, coupure de fibre, ou simple envie de ne rien envoyer à personne.
//
// On ne parle ici que le dialecte `/v1/chat/completions` : c'est celui que tous
// les serveurs locaux comprennent. Les extensions de LM Studio (`/api/v0`) ne
// servent qu'à connaître la taille de fenêtre du modèle chargé, et leur absence
// n'empêche rien.

export const SERVEUR_DEFAUT = process.env.REDACTEUR_SERVEUR || 'http://localhost:1234/v1'

/** Repère de repli quand le serveur ne dit pas la taille de sa fenêtre. */
export const CONTEXTE_DEFAUT = 16384

/** Une adresse tapée à la main se termine rarement comme il faut. */
export function racine(base) {
  let s = String(base || SERVEUR_DEFAUT).trim().replace(/\s+/g, '')
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  s = s.replace(/\/+$/, '')
  if (!/\/v\d+$/.test(s)) s = `${s}/v1`
  return s
}

/** La base sans le `/v1` : c'est là que vivent les extensions LM Studio. */
function hote(base) {
  return racine(base).replace(/\/v\d+$/, '')
}

async function json(url, { signal, timeout = 8000 } = {}) {
  const ctrl = new AbortController()
  const minuteur = setTimeout(() => ctrl.abort(), timeout)
  const relais = () => ctrl.abort()
  signal?.addEventListener('abort', relais, { once: true })
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
    if (!r.ok) throw new Error(`${r.status} ${r.statusText || ''}`.trim())
    return await r.json()
  } finally {
    clearTimeout(minuteur)
    signal?.removeEventListener('abort', relais)
  }
}

/**
 * Les modèles disponibles, avec ce qu'on sait d'eux : taille de fenêtre, état de
 * chargement, capacité à appeler des outils. Les modèles d'embedding sont écartés :
 * ils ne savent pas discuter, les proposer dans le menu n'aurait aucun sens.
 * @returns {Promise<Array<{id:string,contexte:number,charge:boolean,outils:boolean,type:string}>>}
 */
export async function listerModeles(base, { signal } = {}) {
  const detail = new Map()
  try {
    const d = await json(`${hote(base)}/api/v0/models`, { signal })
    for (const m of d?.data || []) detail.set(m.id, m)
  } catch {
    // Serveur sans les extensions LM Studio : on se contentera de `/v1/models`.
  }

  const d = await json(`${racine(base)}/models`, { signal })
  const modeles = []
  for (const m of d?.data || []) {
    const info = detail.get(m.id) || {}
    const type = info.type || ''
    if (type === 'embeddings' || /embed/i.test(m.id)) continue
    modeles.push({
      id: m.id,
      type: type || 'llm',
      contexte: Number(info.loaded_context_length || info.max_context_length || 0) || 0,
      charge: info.state === 'loaded',
      // Un modèle que le serveur ne décrit pas est présumé capable : mieux vaut
      // le laisser essayer que le cacher à tort.
      outils: info.capabilities ? info.capabilities.includes('tool_use') : true,
    })
  }
  return modeles
}

/** La fenêtre de contexte du modèle, en jetons. 0 si le serveur ne la dit pas. */
export async function contexteDe(base, model, { signal } = {}) {
  try {
    const m = (await listerModeles(base, { signal })).find((x) => x.id === model)
    return m?.contexte || 0
  } catch {
    return 0
  }
}

/** Le serveur répond-il ? Sert à distinguer « éteint » de « lent ». */
export async function joignable(base, { signal } = {}) {
  try {
    await json(`${racine(base)}/models`, { signal, timeout: 4000 })
    return true
  } catch (err) {
    return false
  }
}

/**
 * Un compteur de jetons approximatif, sans tokenizer.
 *
 * On ne cherche pas la précision : on cherche à ne pas dépasser la fenêtre. Le
 * français tourne autour de 3,3 caractères par jeton ; on compte un peu large,
 * parce qu'une estimation trop basse coûte une requête refusée.
 */
export function estimerJetons(v) {
  if (v == null) return 0
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return Math.ceil(s.length / 3)
}

/** Les jetons d'un message complet, outils compris. */
export function jetonsMessage(m) {
  let n = 4
  n += estimerJetons(m.content || '')
  if (m.tool_calls) for (const a of m.tool_calls) n += estimerJetons(a.function?.name) + estimerJetons(a.function?.arguments) + 6
  return n
}

const TAGS_PENSEE = [['<think>', '</think>'], ['<thinking>', '</thinking>'], ['<reasoning>', '</reasoning>']]

/**
 * Certains modèles rendent leur réflexion dans un champ dédié (`reasoning_content`),
 * d'autres la glissent dans le texte entre balises. On ramène les deux au même
 * endroit : la fenêtre affiche « il réfléchit », jamais des chevrons.
 */
function separateurPensee() {
  let dans = false
  let tampon = ''
  return (morceau, fin = false) => {
    let texte = ''
    let pensee = ''
    tampon += morceau
    // À la fin du flux, plus rien ne viendra compléter une balise coupée : ce qui
    // reste est du texte, et il doit sortir en entier.
    if (fin) {
      const reste = tampon
      tampon = ''
      return dans ? { texte, pensee: pensee + reste } : { texte: texte + reste, pensee }
    }
    while (tampon) {
      if (dans) {
        const fin = TAGS_PENSEE.map(([, f]) => [f, tampon.indexOf(f)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1])[0]
        if (!fin) {
          // La balise de fin peut être coupée en deux morceaux : on garde de quoi
          // la reconnaître au tour suivant.
          const garde = Math.max(...TAGS_PENSEE.map(([, f]) => f.length))
          pensee += tampon.slice(0, Math.max(0, tampon.length - garde))
          tampon = tampon.slice(Math.max(0, tampon.length - garde))
          break
        }
        pensee += tampon.slice(0, fin[1])
        tampon = tampon.slice(fin[1] + fin[0].length)
        dans = false
        continue
      }
      const debut = TAGS_PENSEE.map(([d]) => [d, tampon.indexOf(d)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1])[0]
      if (!debut) {
        const garde = Math.max(...TAGS_PENSEE.map(([d]) => d.length))
        texte += tampon.slice(0, Math.max(0, tampon.length - garde))
        tampon = tampon.slice(Math.max(0, tampon.length - garde))
        break
      }
      texte += tampon.slice(0, debut[1])
      tampon = tampon.slice(debut[1] + debut[0].length)
      dans = true
    }
    return { texte, pensee }
  }
}

class ErreurMoteur extends Error {
  constructor(message, { statut, base } = {}) {
    super(message)
    this.statut = statut
    this.base = base
  }
}

/** Un message d'erreur qui dit quoi faire, pas une pile d'appels. */
function expliquer(err, base) {
  const m = String(err?.message || err)
  if (err?.name === 'AbortError') return new ErreurMoteur('Interrompu.', { base })
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|network/i.test(m)) {
    return new ErreurMoteur(
      `Le serveur local ne répond pas (${racine(base)}). Vérifie que LM Studio tourne, que son serveur est démarré `
      + 'et que la machine est joignable sur le réseau.',
      { base },
    )
  }
  return new ErreurMoteur(m, { base })
}

/**
 * Un tour de modèle, en flux.
 *
 * Rend le message complet une fois fini : son texte, sa réflexion, et les outils
 * qu'il veut appeler. Le flux sert à remplir la fenêtre au fil de l'eau ; c'est le
 * retour qui fait foi.
 *
 * @param {object} o
 * @param {string} o.base adresse du serveur (`http://…/v1`)
 * @param {string} o.modele identifiant du modèle
 * @param {Array} o.messages historique au format OpenAI
 * @param {Array} [o.outils] définitions d'outils (`{type:'function', function:{…}}`)
 * @param {AbortSignal} [o.signal]
 * @param {(t:string)=>void} [o.surTexte]
 * @param {(t:string)=>void} [o.surPensee]
 * @returns {Promise<{texte:string,pensee:string,appels:Array,raison:string,usage:object}>}
 */
export async function completer({
  base, modele, messages, outils = [], signal,
  surTexte = () => {}, surPensee = () => {}, temperature = 0.3, maxJetons = 4096,
  // Un serveur local peut se figer (modèle déchargé, machine en veille) sans jamais
  // fermer la connexion. Sans cette limite, la fenêtre resterait « en réflexion »
  // pour toujours. Large, car sur une longue conversation le modèle peut mettre
  // plusieurs minutes avant de rendre son premier mot.
  inactivite = 300000,
}) {
  const corps = {
    model: modele,
    messages,
    stream: true,
    temperature,
    max_tokens: maxJetons,
  }
  if (outils.length) {
    corps.tools = outils
    corps.tool_choice = 'auto'
  }

  // On coupe nous-mêmes en cas de silence, tout en relayant l'interruption de Nicolas.
  const ctrl = new AbortController()
  let silence = false
  let minuteur = null
  const armer = () => {
    clearTimeout(minuteur)
    minuteur = setTimeout(() => { silence = true; ctrl.abort() }, inactivite)
  }
  const relais = () => ctrl.abort()
  signal?.addEventListener('abort', relais, { once: true })
  const desarmer = () => {
    clearTimeout(minuteur)
    signal?.removeEventListener('abort', relais)
  }
  const muet = () => new ErreurMoteur(
    `Le serveur local (${racine(base)}) n'a rien renvoyé pendant ${Math.round(inactivite / 60000)} minutes. `
    + 'Le modèle est peut-être déchargé, ou la machine en veille. Relance le tour quand il répond de nouveau.',
    { base },
  )
  armer()

  let reponse
  try {
    reponse = await fetch(`${racine(base)}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(corps),
    })
  } catch (err) {
    desarmer()
    throw silence ? muet() : expliquer(err, base)
  }

  if (!reponse.ok) {
    desarmer()
    const detail = await reponse.text().catch(() => '')
    let message = ''
    try {
      const j = JSON.parse(detail)
      if (j?.error) message = typeof j.error === 'string' ? j.error : (j.error.message || '')
    } catch {
      // Un serveur qui tombe rend parfois une page d'erreur HTML : on n'en garde que
      // le texte, sinon la fenêtre afficherait du balisage à la place d'un message.
      message = detail.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
    }
    const code = `${reponse.status} ${reponse.statusText || ''}`.trim()
    if (reponse.status === 404) {
      throw new ErreurMoteur(
        `Le serveur ne connaît pas le modèle « ${modele} ». Charge-le dans LM Studio, ou choisis-en un autre.`,
        { statut: 404, base },
      )
    }
    throw new ErreurMoteur(
      `Le serveur local a refusé la demande (${code}${message ? ` — ${message}` : ''}). `
      + 'Regarde le journal de LM Studio : le modèle est peut-être déchargé, ou la conversation trop longue '
      + 'pour sa fenêtre de contexte.',
      { statut: reponse.status, base },
    )
  }

  const decodeur = new TextDecoder()
  const separer = separateurPensee()
  let tampon = ''
  let texte = ''
  let pensee = ''
  let raison = ''
  let usage = null
  /** index -> {id, name, args} : les appels arrivent par morceaux, numérotés. */
  const appels = new Map()

  const avaler = (ligne) => {
    if (!ligne.startsWith('data:')) return
    const brut = ligne.slice(5).trim()
    if (!brut || brut === '[DONE]') return
    let evt
    try { evt = JSON.parse(brut) } catch { return }
    if (evt.usage) usage = evt.usage
    const choix = evt.choices?.[0]
    if (!choix) return
    if (choix.finish_reason) raison = choix.finish_reason
    const d = choix.delta || choix.message || {}

    const reflexion = d.reasoning_content ?? d.reasoning
    if (reflexion) { pensee += reflexion; surPensee(reflexion) }

    if (d.content) {
      const part = separer(d.content)
      if (part.pensee) { pensee += part.pensee; surPensee(part.pensee) }
      if (part.texte) { texte += part.texte; surTexte(part.texte) }
    }

    for (const a of d.tool_calls || []) {
      const i = a.index ?? appels.size
      const entree = appels.get(i) || { id: '', nom: '', args: '' }
      if (a.id) entree.id = a.id
      if (a.function?.name) entree.nom += a.function.name
      if (a.function?.arguments) entree.args += a.function.arguments
      appels.set(i, entree)
    }
  }

  try {
    for await (const bloc of reponse.body) {
      armer()
      tampon += decodeur.decode(bloc, { stream: true })
      const lignes = tampon.split('\n')
      tampon = lignes.pop() || ''
      for (const l of lignes) avaler(l.trim())
    }
    if (tampon.trim()) avaler(tampon.trim())
  } catch (err) {
    // Même interrompu, ce qui a été écrit doit s'afficher en entier : le séparateur
    // de pensée retient toujours quelques caractères, on les rend avant de sortir.
    const arrete = separer('', true)
    if (arrete.texte) surTexte(arrete.texte)
    if (arrete.pensee) surPensee(arrete.pensee)
    desarmer()
    throw silence ? muet() : expliquer(err, base)
  }
  desarmer()

  // Un dernier morceau de texte peut être resté dans le séparateur de pensée.
  const reste = separer('', true)
  if (reste.texte) { texte += reste.texte; surTexte(reste.texte) }
  if (reste.pensee) { pensee += reste.pensee; surPensee(reste.pensee) }

  return {
    texte,
    pensee,
    raison: raison || 'stop',
    usage,
    appels: [...appels.entries()].sort((a, b) => a[0] - b[0]).map(([i, a]) => ({
      id: a.id || `appel_${i}_${Date.now().toString(36)}`,
      nom: a.nom.trim(),
      args: a.args,
    })),
  }
}
