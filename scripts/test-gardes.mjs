// Le garde-fou qui fait toute la valeur de l'app : on ne cite que ce qu'on a lu.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'redacteur-gardes-'))
process.env.REDACTEUR_DATA_DIR = path.join(bac, 'donnees')
process.env.REDACTEUR_BIBLIOTHEQUE = path.join(bac, 'bibliotheque')

const { P } = await import('../src/doc/paths.mjs')
const { GardeRedaction } = await import('../src/agent/gardes.mjs')

fs.mkdirSync(path.dirname(P.registre()), { recursive: true })
fs.writeFileSync(P.registre(), JSON.stringify({
  sequence: 3,
  sources: [
    { id: 's1', cle: 'https://ons.gov.uk/pib', url: 'https://ons.gov.uk/pib', url_finale: 'https://ons.gov.uk/pib', type: 'html', titre: 'GDP', editeur: 'ONS', consultee_le: '2026-08-29T09:00:00Z', taille: 4200 },
    { id: 's2', cle: 'https://london.gov.uk/emploi', url: 'https://london.gov.uk/emploi', url_finale: 'https://london.gov.uk/emploi', type: 'html', titre: 'Emploi', editeur: 'GLA', consultee_le: '2026-08-29T09:05:00Z', taille: 900 },
    { id: 's3', cle: 'https://ft.com/paywall', url: 'https://ft.com/paywall', url_finale: 'https://ft.com/paywall', type: 'html', titre: 'FT', editeur: 'FT', consultee_le: '2026-08-29T09:07:00Z', taille: 0 },
  ],
}, null, 2))

const OUTIL = 'rediger_document'
const neuve = () => new GardeRedaction()

/** Une garde qui a « vu » passer les résultats de consulter_source. */
function apresLecture(...ids) {
  const g = neuve()
  for (const id of ids) g.noteToolResult('consulter_source', JSON.stringify({ source: { id } }))
  return g
}

// 1. Aucune source consultée : on refuse et on explique la marche à suivre.
assert.match(
  neuve().verifier(OUTIL, { titre: 'T', markdown: 'du texte', sources: [] }),
  /Cherche \(`rechercher_web`\)/,
)

// 2. Un identifiant qui n'existe pas au registre.
assert.match(
  apresLecture('s1').verifier(OUTIL, { titre: 'T', markdown: 'texte', sources: ['s1', 's42'] }),
  /Sources inconnues : s42/,
)

// 3. Une adresse citée dans le corps mais jamais ouverte : refus, avec la liste.
const fantome = apresLecture('s1').verifier(OUTIL, {
  titre: 'T',
  markdown: 'La croissance ([source](https://institut-invente.fr/etude-2026)) atteint 3 %.',
  sources: ['s1'],
})
assert.match(fantome, /1 adresse\(s\) que tu n'as jamais ouverte/)
assert.match(fantome, /institut-invente\.fr/)

// 4. La même page, écrite autrement, reste la même page : pas de faux refus.
assert.equal(
  apresLecture('s1').verifier(OUTIL, {
    titre: 'T',
    markdown: 'Voir ([ONS](http://www.ons.gov.uk/pib?utm_source=x#tab)) pour le détail.',
    sources: ['s1'],
  }),
  null,
)

// 5. Une page qui n'a rendu aucun texte n'a pas été lue.
assert.match(
  apresLecture('s1', 's3').verifier(OUTIL, { titre: 'T', markdown: 'texte', sources: ['s1', 's3'] }),
  /n'a rendu aucun texte/,
)

// 6. Des sources lues mais aucune citée.
assert.match(
  apresLecture('s1', 's2').verifier(OUTIL, { titre: 'T', markdown: 'texte', sources: [] }),
  /mais tu n'en cites aucune/,
)

// 7. « sans_source » ne sert pas à esquiver une lecture déjà faite.
assert.match(
  apresLecture('s1').verifier(OUTIL, { titre: 'T', markdown: 'texte', sources: [], sans_source: true }),
  /Cite ces sources/,
)

// 8. Un texte sans recherche, assumé : autorisé.
assert.equal(neuve().verifier(OUTIL, { titre: 'T', markdown: 'texte', sources: [], sans_source: true }), null)

// 9. Ne citer que d'anciennes lectures : on redemande de rouvrir les sources.
assert.match(
  neuve().verifier(OUTIL, { titre: 'T', markdown: 'texte', sources: ['s1'] }),
  /conversations précédentes/,
)

// 10. Le cas nominal.
assert.equal(
  apresLecture('s1', 's2').verifier(OUTIL, {
    titre: 'Londres',
    markdown: '## En bref\n\n- 1,4 % ([ONS](https://ons.gov.uk/pib)), emploi ([GLA](https://london.gov.uk/emploi)).',
    sources: ['s1', 's2'],
  }),
  null,
)

// 11. Une adresse qui n'en est pas une.
assert.match(
  neuve().verifier('consulter_source', { url: '/Users/demo/note.pdf' }),
  /n'est pas une adresse http/,
)
assert.equal(neuve().verifier('consulter_source', { url: 'https://insee.fr' }), null)

// 12. Les outils qui ne sont pas les nôtres passent sans conditions.
assert.equal(neuve().verifier('rechercher_web', { requete: 'londres' }), null)

fs.rmSync(bac, { recursive: true, force: true })
console.log('gardes : OK')
