// Les outils que l'assistant a sous la main : un serveur MCP interne au processus.
//
// L'application ne fait qu'une chose — écrire des documents Markdown fiables — et
// ces outils tracent le seul chemin qui y mène : on consulte, puis on rédige. Une
// page ne devient citable qu'en étant passée par `consulter_source`, et la
// bibliographie du document est composée à partir de ce registre, jamais de mémoire.
import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { consulter, registre, parId, texteSource, jolieDate } from '../doc/sources.mjs'
import {
  ecrireDocument, listerDocuments, lireDocument, supprimerDocument, existe, compterMots, nomFichier,
  versionsDocument, lireVersion, restaurerVersion,
} from '../doc/bibliotheque.mjs'
import { P } from '../doc/paths.mjs'

const texte = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] })
const erreur = (m) => ({ content: [{ type: 'text', text: `ERREUR : ${m}` }], isError: true })

class Refus extends Error {}

/** Enveloppe commune : une panne réseau revient au modèle en clair, jamais en exception. */
const sur = (fn) => async (args, extra) => {
  try {
    return texte(await fn(args, extra))
  } catch (err) {
    if (err instanceof Refus) return texte({ execute: false, refuse: true, message: err.message })
    return erreur(err?.message || String(err))
  }
}

const BANNIERE_SANS_SOURCE =
  '> ⚠️ **Document rédigé sans source consultée.** Son contenu vient des connaissances générales du modèle, ' +
  'pas de documents vérifiés : les chiffres et les dates sont à recouper avant tout usage sérieux.'

export function serveurRedacteur(contexte = {}) {
  const confirmer = contexte.confirmer || (async () => true)
  const signaler = contexte.signaler || (() => {})
  const ouvrir = contexte.ouvrir || (() => false)
  const titrer = contexte.titrer || (() => {})
  // Supprimer envoie à la corbeille : puisque l'assistant décide seul, ce qu'il
  // décide doit rester rattrapable.
  const corbeille = contexte.corbeille || (async () => false)
  const modele = contexte.modele || (() => null)

  async function valider(demande) {
    const ok = await confirmer(demande)
    if (!ok) throw new Refus(demande.refus || "Refusé par Nicolas — rien n'a été fait.")
  }

  // ---------------------------------------------------------------- sources

  const sources = [
    tool(
      'consulter_source',
      "Lit vraiment une page web et l'inscrit au registre des sources. C'est le SEUL moyen d'obtenir le " +
      "contenu d'une adresse, et le seul moyen de gagner le droit de la citer : un document qui cite une " +
      "URL non passée par ici est refusé. Rend le texte de la page, son titre, son éditeur et sa date.",
      {
        url: z.string().describe('adresse http(s) complète'),
        relire: z.boolean().optional().describe('true pour re-télécharger une page déjà lue (donnée qui bouge)'),
      },
      sur(async ({ url, relire }) => {
        const { source, texte: contenu, deja_lue, tronquee } = await consulter(url, { relire: !!relire })
        signaler({ k: 'source', source, deja_lue })
        if (source.type === 'pdf') {
          return {
            source,
            pdf: source.fichier,
            note: `C'est un PDF. Il est enregistré sur le disque : ouvre-le avec l'outil Read (\`${source.fichier}\`). ` +
              'Il est déjà inscrit au registre, tu peux donc le citer.',
          }
        }
        if (!contenu?.trim()) {
          return { source, texte: '', avertissement: "La page n'a rendu aucun texte exploitable (site en JavaScript, mur payant…). Ne la cite pas comme si tu l'avais lue." }
        }
        return {
          source,
          deja_lue,
          consultee_le: jolieDate(source.consultee_le),
          tronquee: tronquee || undefined,
          note: tronquee ? 'Texte tronqué : appelle relire_source si tu as besoin de la suite.' : undefined,
          texte: contenu,
        }
      }),
    ),

    tool(
      'sources_consultees',
      'Le registre des sources déjà lues : leurs identifiants (s1, s2…), titres, éditeurs, adresses et dates de ' +
      "consultation. Ce sont les seuls identifiants acceptés par `rediger_document`.",
      {},
      sur(async () => {
        const liste = registre()
        return {
          nombre: liste.length,
          sources: liste,
          note: liste.length ? undefined : "Aucune source lue pour l'instant.",
        }
      }),
    ),

    tool(
      'relire_source',
      "Relit le texte déjà enregistré d'une source, sans repasser par le réseau. Utile pour retrouver un " +
      'chiffre exact après une longue conversation.',
      {
        id: z.string().describe('identifiant du registre, ex : « s3 »'),
        contient: z.string().optional().describe('ne rendre que les passages contenant ce mot'),
      },
      sur(async ({ id, contient }) => {
        const source = parId(id)
        if (!source) throw new Error(`Aucune source « ${id} » au registre. Appelle sources_consultees.`)
        const contenu = texteSource(id) || ''
        if (!contient) return { source, texte: contenu }
        const lignes = contenu.split('\n')
        const gardees = []
        lignes.forEach((l, i) => {
          if (l.toLowerCase().includes(contient.toLowerCase())) {
            gardees.push(lignes.slice(Math.max(0, i - 2), i + 3).join('\n'))
          }
        })
        return { source, recherche: contient, passages: gardees.slice(0, 25), trouves: gardees.length }
      }),
    ),
  ]

  // ------------------------------------------------------------- documents

  const documents = [
    tool(
      'rediger_document',
      "Enregistre le document Markdown dans la bibliothèque de Nicolas. L'en-tête et la section « Sources » " +
      'sont composés automatiquement à partir des identifiants que tu donnes — ne les écris pas toi-même.\n\n' +
      "Rappeler cet outil sur un document existant (même `nom`) en publie une NOUVELLE VERSION : l'ancienne " +
      "est archivée, rien n'est perdu, et Nicolas n'a rien à valider. C'est ainsi qu'on enrichit ou qu'on " +
      'retouche un document — tu passes le texte complet à chaque fois, jamais un extrait ni un diff.',
      {
        titre: z.string().describe('titre du document, tel qu\'il apparaîtra en tête'),
        markdown: z.string().describe('le corps ENTIER du document, en Markdown, sans en-tête YAML ni bibliographie'),
        sources: z.array(z.string()).describe('identifiants des sources réellement utilisées (s1, s2…)'),
        sujet: z.string().optional().describe('la demande de Nicolas, en une phrase'),
        nom: z.string().optional().describe('nom de fichier d\'un document existant pour en publier une nouvelle version ; sinon composé depuis le titre et la date'),
        sans_source: z.boolean().optional().describe("true seulement si Nicolas a demandé un texte sans recherche : le document portera un avertissement"),
      },
      sur(async ({ titre, markdown, sources: ids = [], sujet, nom, sans_source }) => {
        const cible = nom || nomFichier(titre)
        const corps = sans_source && !ids.length ? `${BANNIERE_SANS_SOURCE}\n\n${markdown}` : markdown
        const info = ecrireDocument({ titre, sujet, markdown: corps, sources: ids, nom: cible, modele: modele() })
        signaler({ k: 'document', document: info })
        // On n'ouvre jamais le fichier de soi-même : Nicolas le lit quand il
        // décide de le lire, depuis la colonne des documents.
        return {
          ...info,
          note: info.remplace
            ? `Version ${info.version} publiée ; la version ${info.version - 1} reste consultable. Dis à Nicolas ce qui a changé, en quelques lignes — ne recopie pas le document dans la conversation.`
            : 'Document enregistré. Annonce-le à Nicolas en quelques lignes — ne recopie pas le document dans la conversation.',
        }
      }),
    ),

    tool(
      'lister_documents',
      'Les documents déjà rédigés : nom de fichier, titre, sujet, nombre de mots et de sources, dates.',
      {},
      sur(async () => ({ bibliotheque: P.bibliotheque(), documents: listerDocuments() })),
    ),

    tool(
      'titrer_conversation',
      "Donne un titre à la conversation en cours, pour la retrouver dans la liste. Appelle-le dès que tu as " +
      'compris la demande, avant de chercher. Trois à sept mots qui disent le sujet, pas la formulation de ' +
      "Nicolas : « Économie de Londres 2026 », pas « Fais-moi un rapport ». Sans point final.",
      { titre: z.string().describe('trois à sept mots') },
      sur(async ({ titre }) => {
        const propre = String(titre).replace(/\s+/g, ' ').trim().replace(/[.。]$/, '').slice(0, 90)
        if (!propre) throw new Error('Titre vide.')
        titrer(propre)
        return { titre: propre }
      }),
    ),

    tool(
      'versions_document',
      "L'historique d'un document : chaque version publiée, son numéro, sa longueur et sa date.",
      { nom: z.string() },
      sur(async ({ nom }) => ({ nom, versions: versionsDocument(nom) })),
    ),

    tool(
      'lire_version',
      "Le contenu d'une version précédente, pour comparer ou récupérer un passage supprimé.",
      { nom: z.string(), numero: z.number().describe('numéro de version, vu dans versions_document') },
      sur(async ({ nom, numero }) => lireVersion(nom, numero)),
    ),

    tool(
      'restaurer_version',
      'Remet une ancienne version en place. Elle devient la version courante, sous un nouveau numéro : ' +
      "l'état d'où l'on revient reste consultable.",
      { nom: z.string(), numero: z.number() },
      sur(async ({ nom, numero }) => {
        const info = restaurerVersion(nom, numero)
        signaler({ k: 'document', document: { ...info, remplace: true, sources_citees: info.sources } })
        return info
      }),
    ),

    tool(
      'lire_document',
      "Le contenu d'un document de la bibliothèque, pour le compléter, le mettre à jour ou s'en inspirer.",
      { nom: z.string().describe('nom de fichier, ex : « 2026-08-29-economie-londres.md »') },
      sur(async ({ nom }) => lireDocument(nom)),
    ),

    tool(
      'ouvrir_document',
      "Ouvre un document dans l'application Markdown de Nicolas.",
      { nom: z.string() },
      sur(async ({ nom }) => {
        const doc = lireDocument(nom)
        ouvrir(doc.chemin)
        return { ouvert: doc.nom }
      }),
    ),

    tool(
      'supprimer_document',
      'Retire un document de la bibliothèque. Il part à la corbeille du Mac, avec son historique.',
      { nom: z.string() },
      sur(async ({ nom }) => {
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
      }),
    ),
  ]

  return createSdkMcpServer({
    name: 'redacteur',
    version: '1.0.0',
    instructions:
      "Outils de rédaction documentaire de Nicolas. Une adresse web ne se lit QUE par `consulter_source` : " +
      "c'est ce qui la rend citable. `rediger_document` compose lui-même l'en-tête et la bibliographie à partir " +
      "des identifiants de sources — n'écris ni l'un ni l'autre à la main, et rappelle-le sur le même `nom` " +
      "pour publier une nouvelle version : rien n'est écrasé, rien n'est à valider. Seule la suppression " +
      'demande une confirmation, et elle apparaît toute seule.',
    tools: [...sources, ...documents],
  })
}
