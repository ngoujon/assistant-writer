// Ce qui arrive dans le fichier .md : en-tête, corps, bibliographie composée.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'redacteur-test-'))
process.env.REDACTEUR_DATA_DIR = path.join(bac, 'donnees')
process.env.REDACTEUR_BIBLIOTHEQUE = path.join(bac, 'bibliotheque')

const { P } = await import('../src/doc/paths.mjs')
const bib = await import('../src/doc/bibliotheque.mjs')

// Un registre de sources factice : on teste la composition, pas le réseau.
fs.mkdirSync(path.dirname(P.registre()), { recursive: true })
fs.writeFileSync(P.registre(), JSON.stringify({
  sequence: 2,
  sources: [
    {
      id: 's1', cle: 'https://ons.gov.uk/pib', url: 'https://ons.gov.uk/pib', url_finale: 'https://ons.gov.uk/pib',
      type: 'html', titre: 'GDP, UK regions', editeur: 'ONS', auteur: null,
      date_publication: '2026-06-11', consultee_le: '2026-08-29T09:00:00.000Z', taille: 4200,
    },
    {
      id: 's2', cle: 'https://london.gov.uk/emploi', url: 'https://london.gov.uk/emploi', url_finale: 'https://london.gov.uk/emploi',
      type: 'html', titre: 'Labour market', editeur: 'GLA', auteur: 'Economics Unit',
      date_publication: null, consultee_le: '2026-08-29T09:05:00.000Z', taille: 900,
    },
  ],
}, null, 2))

const info = bib.ecrireDocument({
  titre: 'Situation économique de Londres',
  sujet: 'rapport complet',
  markdown: '## En bref\n\n- Croissance de 1,4 % ([ONS](https://ons.gov.uk/pib)).\n\n## Sources\n\n- une liste écrite à la main, à jeter',
  sources: ['s1', 's2'],
  modele: 'claude-opus-5',
})

const brut = fs.readFileSync(info.chemin, 'utf8')
assert.ok(brut.startsWith('---\n'), "le document porte un en-tête YAML")
assert.match(brut, /titre: "Situation économique de Londres"/)
assert.match(brut, /sources: 2/)
assert.match(brut, /^# Situation économique de Londres$/m, 'le titre H1 est ajouté s\'il manque')
assert.ok(!brut.includes('à jeter'), 'la section « Sources » écrite à la main est remplacée')
assert.match(brut, /## Sources/)
assert.match(brut, /1\. \*\*GDP, UK regions\*\* — ONS — publié le 11 juin 2026/)
assert.match(brut, /2\. \*\*Labour market\*\* — Economics Unit — GLA/)
assert.match(brut, /<https:\/\/london\.gov\.uk\/emploi>/)
assert.match(brut, /consultée le 29 août 2026/)
assert.equal(info.sources_citees, 2)
assert.equal(info.remplace, false)

assert.equal(info.version, 1)
assert.equal(info.versions, 0, 'un document neuf n\'a pas encore d\'archive')

const relu = bib.lireDocument(info.nom)
assert.equal(relu.titre, 'Situation économique de Londres')
assert.ok(relu.markdown.includes('En bref'))

// Réécrire publie une version : l'ancienne est archivée, pas perdue.
const maj = bib.ecrireDocument({
  titre: 'Situation économique de Londres', markdown: '## En bref\n\n- Révision.', sources: ['s1'],
  nom: info.nom,
})
assert.equal(maj.remplace, true)
assert.equal(maj.version, 2)
assert.equal(maj.versions, 1, 'la version 1 est passée aux archives')
assert.equal(maj.sources_citees, 1)
assert.equal(bib.separerFrontmatter(fs.readFileSync(maj.chemin, 'utf8')).entete.cree_le, relu.entete.cree_le,
  'la date de création survit à une réécriture')

// L'historique se relit, et la version 1 a bien gardé son contenu d'origine.
const hist = bib.versionsDocument(info.nom)
assert.deepEqual(hist.map((v) => v.numero), [2, 1])
assert.equal(hist[0].courante, true)
assert.equal(hist[1].courante, false)
const v1 = bib.lireVersion(info.nom, 1)
assert.ok(v1.markdown.includes('Croissance de 1,4 %'), 'la version 1 est intacte')
assert.ok(!bib.lireDocument(info.nom).markdown.includes('Croissance de 1,4 %'))

// Restaurer une ancienne version la remet en place sous un nouveau numéro.
const remis = bib.restaurerVersion(info.nom, 1)
assert.equal(remis.version, 3)
assert.ok(bib.lireDocument(info.nom).markdown.includes('Croissance de 1,4 %'))
assert.deepEqual(bib.versionsDocument(info.nom).map((v) => v.numero), [3, 2, 1])
assert.throws(() => bib.lireVersion(info.nom, 9), /n'a pas de version 9/)

// Une source inconnue ne se glisse pas dans la bibliographie.
const sansBiblio = bib.ecrireDocument({ titre: 'Test fantôme', markdown: 'corps', sources: ['s9'] })
assert.equal(sansBiblio.sources_citees, 0)
assert.ok(!fs.readFileSync(sansBiblio.chemin, 'utf8').includes('## Sources'))

// Le dossier « Versions » n'est pas un document.
assert.equal(bib.listerDocuments().length, 2)
assert.equal(bib.listerDocuments()[0].nom, sansBiblio.nom, 'le plus récemment modifié en tête')

fs.rmSync(bac, { recursive: true, force: true })
console.log('bibliothèque : OK')
