// Mise à plat d'une page : ce que le modèle lira à la place du HTML.
import assert from 'node:assert/strict'
import { htmlVersTexte, normaliserUrl, urlsDuTexte, decoderEntites } from '../src/doc/web.mjs'

const PAGE = `<!doctype html><html><head>
  <title>PIB de Londres &amp; emploi</title>
  <meta property="og:site_name" content="Office for National Statistics">
  <script>var pub = 'pub';</script>
  <style>.x{color:red}</style>
</head><body>
  <nav>Accueil | Contact</nav>
  <article>
    <h1>Le PIB londonien</h1>
    <p>La croissance atteint 1,4&nbsp;% au T2&nbsp;2026, selon l&rsquo;institut.</p>
    <ul><li>Services : 88&nbsp;%</li><li>Industrie : 4&nbsp;%</li></ul>
    <table><tr><td>2025</td><td>1,1 %</td></tr></table>
  </article>
  <footer>Mentions légales</footer>
</body></html>`

const texte = htmlVersTexte(PAGE)
assert.ok(!texte.includes('var pub'), 'les scripts doivent disparaître')
assert.ok(!texte.includes('color:red'), 'les styles doivent disparaître')
assert.ok(!texte.includes('Mentions légales'), 'le pied de page doit disparaître')
assert.ok(!texte.includes('Accueil |'), 'le menu doit disparaître')
assert.ok(texte.includes('## Le PIB londonien'), 'les titres deviennent des titres Markdown')
assert.ok(texte.includes("l’institut"), 'les entités sont décodées')
assert.ok(texte.includes('1,4 % au T2 2026'), 'les espaces insécables deviennent des espaces')
assert.ok(texte.includes('- Services : 88 %'), 'les listes sont conservées')
assert.ok(texte.includes('2025 | 1,1 %'), 'les tableaux restent lisibles')
assert.ok(!/\n{3,}/.test(texte), 'pas de trous de trois lignes')

assert.equal(decoderEntites('caf&eacute; &#233; &#x41;'), 'café é A')

// Deux écritures de la même page ne doivent pas passer pour deux sources.
assert.equal(
  normaliserUrl('http://WWW.Insee.fr/statistiques/12/?utm_source=news#tableau'),
  normaliserUrl('https://insee.fr/statistiques/12'),
)
assert.notEqual(normaliserUrl('https://a.fr/x'), normaliserUrl('https://a.fr/y'))

// Les URL citées dans un texte, ponctuation comprise.
const trouvees = urlsDuTexte(
  'Voir ([ONS](https://ons.gov.uk/eco), 2026), puis https://insee.fr/x. Et (https://bbc.co.uk/n(1)) enfin.',
)
assert.deepEqual(trouvees.sort(), ['https://bbc.co.uk/n(1)', 'https://insee.fr/x', 'https://ons.gov.uk/eco'])

console.log('extraction : OK')
