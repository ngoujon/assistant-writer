// Le moteur local, de bout en bout — sans LM Studio.
//
// On monte un faux serveur compatible OpenAI sur la machine et on fait tourner une
// vraie session contre lui : appels d'outils, garde-fous, rognage du contexte,
// interruption. C'est le test qui dit si l'application marche encore quand on
// remplace le modèle par un autre — et il tourne partout, sans réseau.
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'redacteur-moteur-'))
process.env.REDACTEUR_DATA_DIR = path.join(bac, 'donnees')
process.env.REDACTEUR_BIBLIOTHEQUE = path.join(bac, 'bibliotheque')

const { AgentSession, lireArguments, appelsDansLeTexte } = await import('../src/agent/session.mjs')
const { estimerJetons, racine } = await import('../src/agent/moteur.mjs')
const { listerDocuments } = await import('../src/doc/bibliotheque.mjs')

// ------------------------------------------------------------- faux serveur

/** Ce que le faux modèle répondra, dans l'ordre. Chaque tour consomme une entrée. */
let scenario = []
/** Les corps de requête reçus : c'est là qu'on vérifie ce qu'on a vraiment envoyé. */
let recues = []
let contexteAnnonce = 16384

function sse(res, morceaux) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  for (const m of morceaux) res.write(`data: ${JSON.stringify(m)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const bloc = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] })

/** Un tour « texte » : le modèle parle, éventuellement en réfléchissant d'abord. */
function tourTexte(texte, { pensee } = {}) {
  const out = []
  if (pensee) out.push(bloc({ reasoning_content: pensee }))
  for (const mot of texte.match(/\S+\s*/g) || []) out.push(bloc({ content: mot }))
  out.push(bloc({}, 'stop'))
  return out
}

/** Un tour « outil » : le modèle appelle un outil, par morceaux comme le vrai. */
function tourOutil(nom, args) {
  const json = JSON.stringify(args)
  return [
    bloc({ tool_calls: [{ index: 0, id: `c_${nom}`, type: 'function', function: { name: nom, arguments: '' } }] }),
    bloc({ tool_calls: [{ index: 0, function: { arguments: json.slice(0, 10) } }] }),
    bloc({ tool_calls: [{ index: 0, function: { arguments: json.slice(10) } }] }),
    bloc({}, 'tool_calls'),
  ]
}

const serveur = http.createServer((req, res) => {
  if (req.url.startsWith('/api/v0/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        { id: 'faux-modele', type: 'llm', state: 'loaded', loaded_context_length: contexteAnnonce, capabilities: ['tool_use'] },
        { id: 'un-embedding', type: 'embeddings', state: 'not-loaded' },
      ],
    }))
    return
  }
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'faux-modele' }, { id: 'un-embedding' }] }))
    return
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    let brut = ''
    req.on('data', (c) => { brut += c })
    req.on('end', () => {
      recues.push(JSON.parse(brut))
      const suite = scenario.shift() || tourTexte('Je n\'ai plus rien à dire.')
      if (typeof suite === 'function') return suite(res)
      sse(res, suite)
    })
    return
  }
  if (req.url.startsWith('/page')) {
    const n = req.url.replace(/\D/g, '')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<html><head><title>Page d'essai ${n}</title></head><body><article>`
      + `<h1>Page d'essai ${n}</h1><p>L'inflation s'établit à ${n},2 % en août 2026 selon cette page.</p>`
      + `${'<p>Du texte de remplissage, pour que la page ait un corps lisible.</p>'.repeat(20)}`
      + '</article></body></html>')
    return
  }
  res.writeHead(404)
  res.end()
})

await new Promise((r) => serveur.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${serveur.address().port}/v1`

// ---------------------------------------------------------------- utilitaires

function sessionDeTest(config = {}) {
  const vu = { evts: [], texte: '', pensee: '', outils: [], resultats: [], erreurs: [], notes: [] }
  let fini = null
  const s = new AgentSession({
    emit: (e) => {
      vu.evts.push(e)
      if (e.k === 'text-delta') vu.texte += e.text
      if (e.k === 'thinking-delta') vu.pensee += e.text
      if (e.k === 'tool-use') vu.outils.push(e.name)
      if (e.k === 'tool-result') vu.resultats.push(e)
      if (e.k === 'error') vu.erreurs.push(e.message)
      if (e.k === 'note') vu.notes.push(e.text)
      if (e.k === 'result' || e.k === 'interrupted') fini?.(e)
    },
    askPermission: async () => ({ behavior: 'deny', message: 'test' }),
    getConfig: () => ({ serveur: BASE, model: 'faux-modele', langue: 'français', autonomie: 'auto', ...config }),
    ...config.branchements,
  })
  const attendre = () => new Promise((r) => { fini = r })
  return { s, vu, attendre }
}

// 1. Un tour ordinaire : réflexion, texte, fin. Les événements arrivent dans l'ordre.
{
  scenario = [tourTexte('Bonjour Nicolas. Donne-moi un sujet.', { pensee: 'Message vague.' })]
  const { s, vu, attendre } = sessionDeTest()
  s.start({})
  const fin = attendre()
  s.send('salut')
  const res = await fin
  assert.equal(res.isError, false)
  assert.match(vu.texte, /Donne-moi un sujet/)
  assert.equal(vu.pensee, 'Message vague.')
  assert.ok(vu.evts.some((e) => e.k === 'ready' && e.outils === 'connected'))
  assert.ok(vu.evts.some((e) => e.k === 'text-start'), 'la fenêtre est prévenue avant le texte')
  s.stop()
}

// 2. Un tour avec outils : l'appel est exécuté, son résultat repart au modèle, et le
//    document atterrit vraiment dans la bibliothèque.
{
  scenario = [
    tourOutil('titrer_conversation', { titre: 'Essai du moteur local' }),
    tourOutil('rediger_document', {
      titre: 'Essai du moteur local',
      markdown: '## En bref\n\n- Le moteur local répond.',
      sans_source: true,
    }),
    tourTexte('Document enregistré : 8 mots, sans source.'),
  ]
  const { s, vu, attendre } = sessionDeTest()
  s.start({})
  const fin = attendre()
  s.send('Écris-moi une note sans recherche.')
  await fin

  assert.deepEqual(vu.outils, ['titrer_conversation', 'rediger_document'])
  assert.ok(vu.resultats.every((r) => r.ok), 'aucun outil n\'a échoué')
  assert.ok(vu.evts.some((e) => e.k === 'titre' && e.titre === 'Essai du moteur local'))
  assert.equal(listerDocuments().length, 1)

  // Le modèle a bien reçu le résultat de l'outil, rattaché à son appel.
  const dernier = recues.at(-1)
  const outil = dernier.messages.filter((m) => m.role === 'tool')
  assert.equal(outil.length, 2)
  assert.equal(outil[0].tool_call_id, 'c_titrer_conversation')
  // Et les définitions d'outils partent à chaque tour, sinon il ne sait pas s'en servir.
  assert.ok(dernier.tools.some((t) => t.function.name === 'consulter_source'))
  s.stop()
}

// 3. Le garde-fou passe avant l'outil : un document qui cite une adresse jamais
//    ouverte ne s'écrit pas, et le modèle reçoit de quoi se corriger.
{
  scenario = [
    tourOutil('rediger_document', {
      titre: 'Document inventé',
      markdown: 'Le PIB a progressé ([ONS](https://ons.gov.uk/invente)).',
      sources: ['s1'],
    }),
    tourTexte('Je retire la référence que je n\'ai pas ouverte.'),
  ]
  const avant = listerDocuments().length
  const { s, vu, attendre } = sessionDeTest()
  s.start({})
  const fin = attendre()
  s.send('Écris un document sur le PIB.')
  await fin

  assert.equal(listerDocuments().length, avant, 'rien n\'a été écrit')
  assert.equal(vu.resultats.at(-1).ok, false)
  const retour = recues.at(-1).messages.filter((m) => m.role === 'tool').at(-1)
  assert.match(retour.content, /REFUSÉ/)
  assert.match(retour.content, /Sources inconnues|jamais ouverte/)
  s.stop()
}

// 4. Des arguments mal formés ne cassent pas la session : ils reviennent au modèle.
{
  scenario = [
    () => sse(null, []), // remplacé juste après : on veut un tour d'outil bancal
  ]
  scenario = [
    [
      bloc({ tool_calls: [{ index: 0, id: 'c_bancal', type: 'function', function: { name: 'lire_document', arguments: '{nom: ' } }] }),
      bloc({}, 'tool_calls'),
    ],
    tourTexte('Je réessaie correctement.'),
  ]
  const { s, vu, attendre } = sessionDeTest()
  s.start({})
  const fin = attendre()
  s.send('Relis mon document.')
  await fin
  assert.equal(vu.resultats[0].ok, false)
  assert.match(recues.at(-1).messages.filter((m) => m.role === 'tool')[0].content, /JSON valide/)
  s.stop()
}

// 5. Le contexte est rogné pour tenir dans la fenêtre du modèle : on garde la fin de
//    la conversation, et les vieux résultats d'outils sont abrégés, pas les consignes.
{
  contexteAnnonce = 8192
  scenario = [tourTexte('Reçu.')]
  const { s, attendre } = sessionDeTest()
  s.start({})
  await new Promise((r) => setTimeout(r, 150)) // le temps de lire la taille de fenêtre
  for (let i = 0; i < 40; i += 1) {
    s.messages.push({ role: 'user', content: `Demande numéro ${i}` })
    s.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'relire_source', arguments: '{}' } }] })
    s.messages.push({ role: 'tool', tool_call_id: `t${i}`, name: 'relire_source', content: 'x'.repeat(4000) })
  }
  const fin = attendre()
  s.send('Et maintenant ?')
  await fin

  const envoye = recues.at(-1).messages
  const jetons = envoye.reduce((n, m) => n + estimerJetons(m.content || '') + estimerJetons(m.tool_calls || ''), 0)
  assert.ok(jetons < 8192, `le contexte envoyé tient dans la fenêtre (${jetons} jetons)`)
  assert.equal(envoye[0].role, 'system', 'les consignes restent en tête')
  assert.match(envoye[0].content, /Assistant Rédacteur/)
  assert.equal(envoye.at(-1).content, 'Et maintenant ?', 'la dernière demande est toujours là')
  assert.notEqual(envoye[1].role, 'tool', 'aucun résultat d\'outil orphelin')
  contexteAnnonce = 16384
  s.stop()
}

// 6. Interrompre pendant que le modèle écrit : la session s'arrête, et reste utilisable.
{
  scenario = [(res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify(bloc({ content: 'Je commence à écrire' }))}\n\n`)
    // Puis plus rien : la réponse reste ouverte jusqu'à l'interruption.
  }]
  const { s, vu, attendre } = sessionDeTest()
  s.start({})
  const fin = attendre()
  s.send('Un long rapport.')
  await new Promise((r) => setTimeout(r, 200))
  await s.interrupt()
  const evt = await fin
  assert.equal(evt.k, 'interrupted')
  assert.match(vu.texte, /Je commence/)
  // Une interruption n'est pas une panne : rien ne doit s'afficher en erreur.
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(vu.erreurs, [], 'interrompre ne signale pas d\'erreur')
  assert.ok(!vu.evts.some((e) => e.k === 'result'), 'et ne clôt pas le tour une deuxième fois')

  // Et la session reste utilisable : le message suivant repart normalement.
  scenario = [tourTexte('Me revoilà.')]
  const fin2 = attendre()
  s.send('Reprends.')
  const apres = await fin2
  assert.equal(apres.isError, false)
  assert.match(vu.texte, /Me revoilà/)
  s.stop()
}

// 5 bis. Une fenêtre étroite se signale à l'ouverture, avec le geste qui la corrige.
{
  contexteAnnonce = 8192
  const { s, vu } = sessionDeTest()
  s.start({})
  await new Promise((r) => setTimeout(r, 200))
  const dit = vu.notes.join(' ')
  // Le séparateur de milliers du français est une espace fine insécable.
  assert.match(dit, /8\s192\s*jetons/)
  assert.match(dit, /Context Length/)
  contexteAnnonce = 16384
  s.stop()
}

// 6 bis. Un serveur qui se fige : on rend la main au lieu de « réfléchir » pour toujours.
{
  scenario = [(res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify(bloc({ content: 'Je réfléchis' }))}\n\n`)
    // Et puis plus rien, jamais.
  }]
  // Deux secondes de silence suffisent ici ; l'application en laisse cinq minutes.
  const { s, vu, attendre } = sessionDeTest({ inactiviteMs: 2000 })
  s.start({})
  const fin = attendre()
  s.send('Un rapport.')
  const res = await fin
  assert.equal(res.isError, true)
  assert.match(vu.erreurs.join(' '), /n'a rien renvoyé/)
  assert.match(vu.texte, /Je réfléchis/, 'ce qui était déjà écrit reste affiché')
  s.stop()
}

// 7. Serveur éteint : on le dit en français, avec quoi faire — et sans exception.
{
  const { s, vu, attendre } = sessionDeTest({ serveur: 'http://127.0.0.1:1/v1' })
  s.start({})
  const fin = attendre()
  s.send('Bonjour ?')
  const res = await fin
  assert.equal(res.isError, true)
  assert.match(vu.erreurs.join(' '), /serveur local ne répond pas/i)
  assert.match(vu.erreurs.join(' '), /LM Studio/)
  s.stop()
}

// 8. Reprise : l'historique enregistré revient au démarrage suivant, et avec lui la
//    mémoire des sources lues — sinon le garde-fou refuserait de les citer.
{
  const memoire = new Map()
  scenario = [tourTexte('Je reprends où j\'en étais.')]
  const { s, attendre } = sessionDeTest({
    branchements: {
      chargerHistorique: () => memoire.get('fil') || [],
      enregistrerHistorique: (_id, messages) => memoire.set('fil', messages),
    },
  })
  s.start({})
  const fin = attendre()
  s.send('Première demande')
  await fin
  assert.ok(memoire.get('fil').length >= 2, 'le contexte du modèle est enregistré')
  s.stop()

  scenario = [tourTexte('Suite.')]
  s.start({ resume: 'fil' })
  const fin2 = attendre()
  s.send('Deuxième demande')
  await fin2
  const envoye = recues.at(-1).messages.map((m) => m.content)
  assert.ok(envoye.some((c) => c === 'Première demande'), 'la conversation d\'avant est bien là')
  s.stop()

  // Une source lue avant la coupure reste citable après reprise.
  memoire.set('fil', [
    { role: 'user', content: 'Analyse cette page' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'consulter_source', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'consulter_source', content: JSON.stringify({ source: { id: 's7' } }) },
  ])
  s.start({ resume: 'fil' })
  assert.ok(s.garde.luesIci.has('s7'), 'les sources lues avant la coupure sont retrouvées')
  s.stop()
}

// 8 bis. Lire sans jamais publier : l'application le rappelle dans le résultat même
//        de la lecture, parce que c'est là que le modèle décide de la suite.
{
  const pages = [1, 2, 3, 4].map((n) => `http://127.0.0.1:${serveur.address().port}/page${n}`)
  scenario = [
    ...pages.map((url) => tourOutil('consulter_source', { url })),
    tourTexte('Je publie.'),
  ]
  const { s, vu, attendre } = sessionDeTest()
  s.start({})
  const fin = attendre()
  s.send('Analyse ces quatre pages.')
  await fin

  const lectures = vu.resultats.filter((r) => r.name === 'consulter_source')
  assert.equal(lectures.length, 4)
  assert.ok(lectures.every((r) => r.ok), 'les quatre pages ont été lues')
  const rappels = recues.at(-1).messages.filter((m) => m.role === 'tool' && /RAPPEL DE L'APPLICATION/.test(m.content))
  assert.equal(rappels.length, 1, 'le rappel arrive une fois, à la quatrième source')
  assert.match(rappels[0].content, /rediger_document` MAINTENANT/)
  s.stop()
}

// 8 ter. Un tour vide est une hésitation, pas une panne : on relance, et on n'abandonne
//        qu'au troisième silence — en disant quoi vérifier.
{
  const vide = [bloc({ content: '' }), bloc({}, 'stop')]
  scenario = [vide, vide, tourTexte('Voilà, je reprends.')]
  const { s, vu, attendre } = sessionDeTest()
  s.start({})
  const fin = attendre()
  s.send('Un rapport sur Londres.')
  const res = await fin
  assert.equal(res.isError, false, 'deux tours vides ne cassent pas la conversation')
  assert.match(vu.texte, /je reprends/)
  assert.match(recues.at(-1).messages.at(-1).content, /réponse était vide/)
  s.stop()
}

// 8 ter bis. Trois silences d'affilée : là, on rend la main avec un diagnostic.
{
  const vide = [bloc({ content: '' }), bloc({}, 'stop')]
  scenario = [vide, vide, vide]
  const { s, attendre } = sessionDeTest()
  s.start({})
  const fin = attendre()
  s.send('Un rapport sur Londres.')
  const res = await fin
  assert.equal(res.isError, true)
  assert.match(res.text, /appeler des outils/)
  assert.match(res.text, /fenêtre de contexte/)
  s.stop()
}

// 8 quater. Une réponse coupée en plein appel d'outil n'est pas exécutée : un
//           document tronqué vaut moins que rien, et le modèle est invité à recommencer.
{
  const moitie = JSON.stringify({ titre: 'Trop long', markdown: '## En bref' }).slice(0, 24)
  scenario = [
    [
      bloc({ tool_calls: [{ index: 0, id: 'c_coupe', type: 'function', function: { name: 'rediger_document', arguments: moitie } }] }),
      bloc({}, 'length'),
    ],
    tourTexte('Je republie en plus court.'),
  ]
  const avant = listerDocuments().length
  const { s, vu, attendre } = sessionDeTest()
  s.start({})
  const fin = attendre()
  s.send('Écris un très long document.')
  await fin

  assert.equal(listerDocuments().length, avant, 'aucun document tronqué enregistré')
  assert.equal(vu.resultats[0].ok, false)
  const renvoye = recues.at(-1)
  assert.match(renvoye.messages.filter((m) => m.role === 'tool')[0].content, /longueur maximale/)
  // Et l'appel remis au serveur porte du JSON valide : sinon il refuse tout le dialogue.
  const appel = renvoye.messages.find((m) => m.tool_calls)?.tool_calls[0]
  assert.doesNotThrow(() => JSON.parse(appel.function.arguments))
  s.stop()
}

// 9. Les petits utilitaires, qui rattrapent ce qu'un modèle local écrit de travers.
{
  assert.deepEqual(lireArguments('{"nom":"a.md"}').args, { nom: 'a.md' })
  assert.deepEqual(lireArguments("{'nom': 'a.md',}").args, { nom: 'a.md' })
  assert.deepEqual(lireArguments('Voici : {"nom":"a.md"}').args, { nom: 'a.md' })
  assert.deepEqual(lireArguments('').args, {})
  assert.ok(lireArguments('n\'importe quoi').erreur)

  const trouves = appelsDansLeTexte('Je cherche. <tool_call>{"name":"rechercher_web","arguments":{"requete":"pib"}}</tool_call>')
  assert.equal(trouves.length, 1)
  assert.equal(trouves[0].nom, 'rechercher_web')
  assert.deepEqual(JSON.parse(trouves[0].args), { requete: 'pib' })
}

// 9 bis. Un serveur qui rend une page d'erreur HTML : on n'en montre que le sens.
{
  scenario = [(res) => {
    res.writeHead(500, { 'Content-Type': 'text/html' })
    res.end('<!DOCTYPE html><html><head><title>Error</title></head><body><pre>Internal Server Error</pre></body></html>')
  }]
  const { s, vu, attendre } = sessionDeTest()
  s.start({})
  const fin = attendre()
  s.send('Un rapport.')
  await fin
  const dit = vu.erreurs.join(' ')
  assert.ok(!/<[a-z]/i.test(dit), `pas de balise dans le message : ${dit}`)
  assert.match(dit, /Internal Server Error/)
  assert.match(dit, /fenêtre de contexte|déchargé/)
  s.stop()
}

// 10. L'adresse du serveur se rattrape quelle que soit la façon dont on la tape.
{
  assert.equal(racine('localhost:1234'), 'http://localhost:1234/v1')
  assert.equal(racine('http://localhost:1234/v1/'), 'http://localhost:1234/v1')
  assert.equal(racine(' http://localhost:1234 '), 'http://localhost:1234/v1')
}

serveur.close()
fs.rmSync(bac, { recursive: true, force: true })
console.log('moteur : OK')
