// Les outils vus de l'intérieur : ce qui déclenche une carte de validation, et ce
// qui n'en déclenche pas. On appelle les gestionnaires directement, sans agent.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'redacteur-outils-'))
process.env.REDACTEUR_DATA_DIR = path.join(bac, 'donnees')
process.env.REDACTEUR_BIBLIOTHEQUE = path.join(bac, 'bibliotheque')

const { P } = await import('../src/doc/paths.mjs')
const { serveurRedacteur } = await import('../src/agent/outils.mjs')
const { listerDocuments } = await import('../src/doc/bibliotheque.mjs')

fs.mkdirSync(path.dirname(P.registre()), { recursive: true })
fs.writeFileSync(P.registre(), JSON.stringify({
  sequence: 1,
  sources: [{
    id: 's1', cle: 'https://ons.gov.uk/pib', url: 'https://ons.gov.uk/pib', url_finale: 'https://ons.gov.uk/pib',
    type: 'html', titre: 'GDP', editeur: 'ONS', consultee_le: '2026-08-29T09:00:00Z', taille: 4200,
  }],
}, null, 2))

/** Construit un serveur dont on pilote la réponse aux cartes de validation. */
function serveur(reponse) {
  const demandes = []
  const signaux = []
  const srv = serveurRedacteur({
    confirmer: async (d) => { demandes.push(d); return reponse },
    signaler: (e) => signaux.push(e),
    modele: () => 'claude-opus-5',
  })
  const outils = srv.instance._registeredTools
  const appeler = async (nom, args) => {
    const res = await outils[nom].handler(args, {})
    const texte = res.content?.[0]?.text ?? ''
    try { return JSON.parse(texte) } catch { return texte }
  }
  return { appeler, demandes, signaux }
}

const DOC = {
  titre: 'Situation économique de Londres',
  markdown: '## En bref\n\n- Croissance de 1,4 % ([ONS](https://ons.gov.uk/pib)).',
  sources: ['s1'],
  sujet: 'test',
}

// 1. Premier enregistrement : aucune carte, et le document part au renderer.
{
  const { appeler, demandes, signaux } = serveur(true)
  const info = await appeler('rediger_document', DOC)
  assert.equal(demandes.length, 0, 'écrire un nouveau document ne se fait pas valider')
  assert.equal(info.remplace, false)
  assert.equal(info.sources_citees, 1)
  assert.equal(signaux.filter((s) => s.k === 'document').length, 1, 'le renderer reçoit la carte du document')
}

// 2. Retoucher le document ne demande rien : ça publie une version de plus.
//    C'est ce qui permet d'enrichir un document au fil de la conversation.
{
  const { appeler, demandes, signaux } = serveur(true)
  const info = await appeler('rediger_document', { ...DOC, markdown: '## En bref\n\n- Version enrichie.' })
  assert.equal(demandes.length, 0, 'une nouvelle version ne se fait pas valider')
  assert.equal(info.remplace, true)
  assert.equal(info.version, 2)
  assert.equal(info.versions, 1)
  assert.match(info.note, /Version 2 publiée/)
  assert.equal(signaux.filter((s) => s.k === 'document').length, 1)
}

// 3. Rien ne se perd : la version précédente se relit, et se remet en place.
{
  const { appeler } = serveur(true)
  const nom = listerDocuments()[0].nom
  const hist = await appeler('versions_document', { nom })
  assert.deepEqual(hist.versions.map((v) => v.numero), [2, 1])

  const v1 = await appeler('lire_version', { nom, numero: 1 })
  assert.ok(v1.markdown.includes('Croissance de 1,4 %'))

  const remis = await appeler('restaurer_version', { nom, numero: 1 })
  assert.equal(remis.version, 3)
  assert.equal(remis.restauree_depuis, 1)
  assert.ok(fs.readFileSync(listerDocuments()[0].chemin, 'utf8').includes('Croissance de 1,4 %'))
}

// 4. Supprimer se fait valider, et le refus laisse le fichier en place.
{
  const nom = listerDocuments()[0].nom
  const { appeler, demandes } = serveur(false)
  const res = await appeler('supprimer_document', { nom })
  assert.equal(demandes.length, 1, 'supprimer, en revanche, se fait toujours valider')
  assert.equal(demandes[0].danger, true)
  assert.equal(res.refuse, true)
  assert.equal(listerDocuments().length, 1)

  const accepte = serveur(true)
  await accepte.appeler('supprimer_document', { nom })
  assert.equal(listerDocuments().length, 0, 'accepté, le document disparaît')
}

// 5. Lire le registre ne demande jamais rien.
{
  const { appeler, demandes } = serveur(false)
  const reg = await appeler('sources_consultees', {})
  assert.equal(reg.nombre, 1)
  assert.equal(demandes.length, 0)
}

// 6. Une source absente du registre : erreur claire, pas d'exception.
{
  const { appeler } = serveur(true)
  const res = await appeler('relire_source', { id: 's99' })
  assert.match(String(res), /ERREUR .*Aucune source/)
}

fs.rmSync(bac, { recursive: true, force: true })
console.log('outils : OK')
