// Les outils que l'assistant a sous la main.
//
// L'application ne fait qu'une chose — écrire des documents Markdown fiables — et
// ces outils tracent le seul chemin qui y mène : on cherche, on consulte, puis on
// rédige. Une page ne devient citable qu'en étant passée par `consulter_source`, et
// la bibliographie du document est composée à partir de ce registre, jamais de mémoire.
//
// Ils étaient servis par un serveur MCP du SDK Claude ; ce sont désormais de simples
// fonctions, décrites en JSON Schema pour un serveur compatible OpenAI. Rien d'autre
// n'a changé : mêmes noms, mêmes garanties, même registre de sources.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { consulter, registre, parId, texteSource, jolieDate } from '../doc/sources.mjs'
import { chercher } from '../doc/recherche.mjs'
import { texteDuPdf } from '../doc/pdf.mjs'
import {
  ecrireDocument, listerDocuments, lireDocument, supprimerDocument, nomFichier,
  versionsDocument, lireVersion, restaurerVersion,
} from '../doc/bibliotheque.mjs'
import { P } from '../doc/paths.mjs'

class Refus extends Error {}

const BANNIERE_SANS_SOURCE =
  '> ⚠️ **Document rédigé sans source consultée.** Son contenu vient des connaissances générales du modèle, '
  + 'pas de documents vérifiés : les chiffres et les dates sont à recouper avant tout usage sérieux.'

const HORS_LIGNE =
  'Mode hors ligne : aucune requête ne sort de cette machine. Tu ne peux ni chercher ni ouvrir de page. '
  + 'Travaille avec les sources déjà au registre (`sources_consultees`, `relire_source`) et les documents de la '
  + "bibliothèque. Si Nicolas veut un texte malgré tout, rédige-le et passe `sans_source: true` — le document "
  + 'portera un avertissement.'

/** Raccourcis de schéma : les définitions restent lisibles, et courtes en contexte. */
const S = {
  texte: (description) => ({ type: 'string', description }),
  entier: (description) => ({ type: 'integer', description }),
  bool: (description) => ({ type: 'boolean', description }),
  liste: (description) => ({ type: 'array', items: { type: 'string' }, description }),
}

const schema = (proprietes = {}, requis = []) => ({
  type: 'object',
  properties: proprietes,
  required: requis,
  additionalProperties: false,
})

/**
 * La boîte à outils, branchée sur la fenêtre.
 *
 * @param {object} contexte
 * @param {(demande:object)=>Promise<boolean>} [contexte.confirmer] ouvre une carte de validation
 * @param {(evt:object)=>void} [contexte.signaler] pousse un événement vers la fenêtre
 * @param {(chemin:string)=>void} [contexte.ouvrir] ouvre un fichier dans le Finder/l'éditeur
 * @param {(titre:string)=>void} [contexte.titrer] nomme la conversation
 * @param {(chemin:string)=>Promise<boolean>} [contexte.corbeille]
 * @param {()=>string} [contexte.modele] le modèle en cours, inscrit dans l'en-tête du document
 * @param {()=>boolean} [contexte.horsLigne] coupe tout accès réseau
 * @param {()=>?string} [contexte.searxng] instance SearXNG à préférer au moteur public
 * @param {()=>string} [contexte.langue]
 * @param {()=>number} [contexte.limiteTexte] caractères de source rendus d'un coup
 */
export function outilsRedacteur(contexte = {}) {
  const confirmer = contexte.confirmer || (async () => true)
  const signaler = contexte.signaler || (() => {})
  const ouvrir = contexte.ouvrir || (() => false)
  const titrer = contexte.titrer || (() => {})
  // Supprimer envoie à la corbeille : puisque l'assistant décide seul, ce qu'il
  // décide doit rester rattrapable.
  const corbeille = contexte.corbeille || (async () => false)
  const modele = contexte.modele || (() => null)
  const horsLigne = contexte.horsLigne || (() => false)
  const searxng = contexte.searxng || (() => null)
  const langue = contexte.langue || (() => 'français')
  // La fenêtre du modèle local est étroite : une page entière la remplirait à elle
  // seule. On rend un extrait, et `relire_source` sert à aller chercher la suite.
  const limiteTexte = contexte.limiteTexte || (() => 6000)

  async function valider(demande) {
    const ok = await confirmer(demande)
    if (!ok) throw new Refus(demande.refus || "Refusé par Nicolas — rien n'a été fait.")
  }

  function exigerReseau() {
    if (horsLigne()) throw new Refus(HORS_LIGNE)
  }

  /** Un extrait de source calibré pour la fenêtre, avec de quoi demander la suite. */
  function extrait(contenu, { depuis = 0 } = {}) {
    const max = Math.max(1200, limiteTexte())
    const total = contenu.length
    const part = contenu.slice(depuis, depuis + max)
    return {
      texte: part,
      caracteres_total: total,
      suite: depuis + part.length < total ? depuis + part.length : undefined,
    }
  }

  const outils = {
    // -------------------------------------------------------------- sources

    rechercher_web: {
      description:
        "Cherche des adresses sur le web. Rend des titres et des adresses, PAS le contenu des pages : "
        + 'pour lire, et pour gagner le droit de citer, utilise `consulter_source`.',
      schema: schema({
        requete: S.texte('la recherche, en mots-clés ; varie les angles et les langues'),
        max: S.entier('nombre de résultats (défaut 8)'),
      }, ['requete']),
      async run({ requete, max }) {
        exigerReseau()
        const r = await chercher(requete, {
          max: Math.min(Math.max(Number(max) || 8, 1), 15),
          searxng: searxng(),
          langue: langue(),
        })
        signaler({ k: 'recherche', requete: r.requete, nombre: r.resultats.length })
        return {
          moteur: r.moteur,
          requete: r.requete,
          resultats: r.resultats,
          note: r.resultats.length
            ? 'Ouvre les pages retenues avec `consulter_source`.'
            : 'Aucun résultat. Reformule, ou tente en anglais.',
        }
      },
    },

    consulter_source: {
      description:
        "Lit une page web et l'inscrit au registre des sources. Seul moyen d'obtenir le contenu d'une adresse, "
        + "et seul moyen de gagner le droit de la citer : citer une URL non passée par ici est refusé.",
      schema: schema({
        url: S.texte('adresse http(s) complète'),
        relire: S.bool('true pour re-télécharger une page déjà lue (donnée qui bouge)'),
      }, ['url']),
      async run({ url, relire }) {
        exigerReseau()
        const { source, texte: contenu, deja_lue, tronquee } = await consulter(url, { relire: !!relire })
        signaler({ k: 'source', source, deja_lue })

        if (source.type === 'pdf') {
          const lu = (() => {
            try { return texteDuPdf(source.fichier) } catch { return { texte: '', image: true, pages: 0 } }
          })()
          if (lu.image) {
            return {
              source,
              pdf: source.fichier,
              avertissement: "Ce PDF n'a rendu aucun texte (document scanné, ou protégé). Tu ne l'as donc pas lu : "
                + 'ne le cite pas, cherche la même information ailleurs.',
            }
          }
          return { source, pdf: source.fichier, pages: lu.pages, ...extrait(lu.texte) }
        }

        if (!contenu?.trim()) {
          return {
            source,
            texte: '',
            avertissement: "La page n'a rendu aucun texte exploitable (site en JavaScript, mur payant…). "
              + "Ne la cite pas comme si tu l'avais lue.",
          }
        }

        return {
          source,
          deja_lue,
          consultee_le: jolieDate(source.consultee_le),
          tronquee: tronquee || undefined,
          ...extrait(contenu),
          note: 'Pour la suite du texte ou un chiffre précis : `relire_source`.',
        }
      },
    },

    sources_consultees: {
      description:
        'Le registre des sources déjà lues : identifiants (s1, s2…), titres, adresses, dates. Seuls identifiants '
        + 'acceptés par `rediger_document`.',
      schema: schema(),
      async run() {
        const liste = registre()
        return {
          nombre: liste.length,
          sources: liste,
          note: liste.length ? undefined : "Aucune source lue pour l'instant.",
        }
      },
    },

    relire_source: {
      description:
        "Relit une source déjà lue, sans repasser par le réseau : un chiffre exact, ou la suite d'une page longue.",
      schema: schema({
        id: S.texte('identifiant du registre, ex : « s3 »'),
        contient: S.texte('ne rendre que les passages contenant ce mot'),
        depuis: S.entier('reprendre la lecture à ce caractère (voir « suite » du dernier extrait)'),
      }, ['id']),
      async run({ id, contient, depuis }) {
        const source = parId(id)
        if (!source) throw new Error(`Aucune source « ${id} » au registre. Appelle sources_consultees.`)
        let contenu = texteSource(id) || ''
        if (!contenu && source.type === 'pdf' && source.fichier) {
          try { contenu = texteDuPdf(source.fichier).texte } catch { contenu = '' }
        }
        if (!contient) return { source, ...extrait(contenu, { depuis: Number(depuis) || 0 }) }

        const lignes = contenu.split('\n')
        const gardees = []
        lignes.forEach((l, i) => {
          if (l.toLowerCase().includes(String(contient).toLowerCase())) {
            gardees.push(lignes.slice(Math.max(0, i - 2), i + 3).join('\n'))
          }
        })
        return { source, recherche: contient, passages: gardees.slice(0, 12), trouves: gardees.length }
      },
    },

    lire_fichier: {
      description: 'Lit un fichier du disque : note, Markdown, texte, CSV ou PDF.',
      schema: schema({
        chemin: S.texte('chemin absolu du fichier'),
        depuis: S.entier('reprendre à ce caractère, pour un fichier long'),
      }, ['chemin']),
      async run({ chemin, depuis }) {
        const abs = path.resolve(String(chemin || '').replace(/^~/, os.homedir()))
        if (!fs.existsSync(abs)) throw new Error(`Aucun fichier à « ${abs} ».`)
        // Un dossier n'est pas une erreur : c'est souvent la bonne question mal posée.
        if (fs.statSync(abs).isDirectory()) return { dossier: abs, fichiers: fs.readdirSync(abs).slice(0, 200) }
        if (/\.pdf$/i.test(abs)) {
          const lu = texteDuPdf(abs)
          if (lu.image) {
            return { fichier: abs, avertissement: 'PDF sans texte extractible (scanné ou protégé) : tu ne peux pas le citer.' }
          }
          return { fichier: abs, pages: lu.pages, ...extrait(lu.texte, { depuis: Number(depuis) || 0 }) }
        }
        return { fichier: abs, ...extrait(fs.readFileSync(abs, 'utf8'), { depuis: Number(depuis) || 0 }) }
      },
    },

    // ------------------------------------------------------------ documents

    rediger_document: {
      description:
        "Enregistre le document dans la bibliothèque. En-tête, sommaire et section « Sources » sont composés par "
        + "l'application : ne les écris pas. Même `nom` = nouvelle version (l'ancienne est archivée, rien à "
        + 'valider) ; tu passes le texte complet à chaque fois, jamais un extrait.',
      schema: schema({
        titre: S.texte("titre du document, tel qu'il apparaîtra en tête"),
        markdown: S.texte('le corps ENTIER du document, en Markdown, sans en-tête ni bibliographie'),
        sources: S.liste('identifiants des sources réellement utilisées (s1, s2…)'),
        sujet: S.texte('la demande de Nicolas, en une phrase'),
        nom: S.texte("nom de fichier d'un document existant, pour en publier une nouvelle version"),
        sans_source: S.bool("true seulement si le texte est écrit sans recherche : le document portera un avertissement"),
      }, ['titre', 'markdown']),
      async run({ titre, markdown, sources: ids = [], sujet, nom, sans_source }) {
        const cible = nom || nomFichier(titre)
        const propres = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String)
        const corps = sans_source && !propres.length ? `${BANNIERE_SANS_SOURCE}\n\n${markdown}` : markdown
        const info = ecrireDocument({ titre, sujet, markdown: corps, sources: propres, nom: cible, modele: modele() })
        signaler({ k: 'document', document: info })
        // On n'ouvre jamais le fichier de soi-même : Nicolas le lit quand il décide
        // de le lire, depuis la colonne des documents.
        return {
          ...info,
          note: info.remplace
            ? `Version ${info.version} publiée ; la version ${info.version - 1} reste consultable. Dis à Nicolas ce `
              + 'qui a changé, en quelques lignes — ne recopie pas le document dans la conversation.'
            : 'Document enregistré. Annonce-le à Nicolas en quelques lignes — ne recopie pas le document dans la conversation.',
        }
      },
    },

    lister_documents: {
      description: 'Les documents déjà rédigés : nom de fichier, titre, sujet, nombre de mots et de sources, dates.',
      schema: schema(),
      async run() {
        return { bibliotheque: P.bibliotheque(), documents: listerDocuments() }
      },
    },

    titrer_conversation: {
      description:
        'Titre de la conversation, pour la retrouver dans la liste. À appeler dès que tu as compris la demande : '
        + 'trois à sept mots sur le sujet, sans point final.',
      schema: schema({ titre: S.texte('trois à sept mots') }, ['titre']),
      async run({ titre }) {
        const propre = String(titre).replace(/\s+/g, ' ').trim().replace(/[.。]$/, '').slice(0, 90)
        if (!propre) throw new Error('Titre vide.')
        titrer(propre)
        return { titre: propre }
      },
    },

    versions_document: {
      description: "L'historique d'un document : chaque version publiée, son numéro, sa longueur et sa date.",
      schema: schema({ nom: S.texte('nom de fichier') }, ['nom']),
      async run({ nom }) {
        return { nom, versions: versionsDocument(nom) }
      },
    },

    lire_version: {
      description: "Le contenu d'une version précédente, pour comparer ou récupérer un passage supprimé.",
      schema: schema({
        nom: S.texte('nom de fichier'),
        numero: S.entier('numéro de version, vu dans versions_document'),
      }, ['nom', 'numero']),
      async run({ nom, numero }) {
        return lireVersion(nom, Number(numero))
      },
    },

    restaurer_version: {
      description:
        "Remet une ancienne version en place, sous un nouveau numéro : l'état d'où l'on revient reste consultable.",
      schema: schema({ nom: S.texte('nom de fichier'), numero: S.entier('numéro de version') }, ['nom', 'numero']),
      async run({ nom, numero }) {
        const info = restaurerVersion(nom, Number(numero))
        signaler({ k: 'document', document: { ...info, remplace: true, sources_citees: info.sources } })
        return info
      },
    },

    lire_document: {
      description: "Le contenu d'un document de la bibliothèque, pour le compléter ou le mettre à jour.",
      schema: schema({ nom: S.texte('nom de fichier, ex : « 2026-08-29-economie-londres.md »') }, ['nom']),
      async run({ nom }) {
        return lireDocument(nom)
      },
    },

    ouvrir_document: {
      description: "Ouvre un document dans l'application Markdown de Nicolas. Seulement s'il le demande.",
      schema: schema({ nom: S.texte('nom de fichier') }, ['nom']),
      async run({ nom }) {
        const doc = lireDocument(nom)
        ouvrir(doc.chemin)
        return { ouvert: doc.nom }
      },
    },

    supprimer_document: {
      description: 'Retire un document de la bibliothèque. Il part à la corbeille du Mac, avec son historique.',
      schema: schema({ nom: S.texte('nom de fichier') }, ['nom']),
      async run({ nom }) {
        const doc = lireDocument(nom)
        await valider({
          outil: 'supprimer_document',
          entree: { nom },
          titre: `Supprimer « ${doc.titre} » ?`,
          lignes: [`${doc.nom}\n${doc.mots} mots, ${doc.sources} source(s), ${doc.versions + 1} version(s)`],
          indice: 'Le document et son historique partent à la corbeille.',
          danger: true,
          refus: 'Refusé : le document est toujours là.',
        })
        const aCorbeille = await corbeille(doc.chemin)
        if (!aCorbeille) supprimerDocument(nom)
        return {
          supprime: doc.nom,
          corbeille: aCorbeille,
          note: aCorbeille
            ? 'Le document est dans la corbeille du Mac : Nicolas peut le récupérer.'
            : 'Le document a été effacé du disque.',
        }
      },
    },
  }

  /** Les définitions telles que les attend un serveur compatible OpenAI. */
  const definitions = Object.entries(outils).map(([nom, o]) => ({
    type: 'function',
    function: { name: nom, description: o.description, parameters: o.schema },
  }))

  return {
    definitions,
    noms: new Set(Object.keys(outils)),

    /**
     * Exécute un outil. Une panne, un refus, une erreur d'argument : tout revient au
     * modèle en texte clair, jamais en exception — c'est ainsi qu'il peut corriger.
     * @returns {Promise<{texte:string, erreur:boolean, refus:boolean}>}
     */
    async executer(nom, args) {
      const outil = outils[nom]
      if (!outil) {
        return {
          texte: `ERREUR : outil « ${nom} » inconnu. Outils disponibles : ${Object.keys(outils).join(', ')}.`,
          erreur: true,
          refus: false,
        }
      }
      try {
        const sortie = await outil.run(args || {})
        return { texte: typeof sortie === 'string' ? sortie : JSON.stringify(sortie, null, 1), erreur: false, refus: false }
      } catch (err) {
        if (err instanceof Refus) {
          return { texte: JSON.stringify({ execute: false, refuse: true, message: err.message }), erreur: false, refus: true }
        }
        return { texte: `ERREUR : ${err?.message || String(err)}`, erreur: true, refus: false }
      }
    },
  }
}

export { HORS_LIGNE }
