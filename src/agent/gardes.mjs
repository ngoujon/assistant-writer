// Garde-fous déterministes. Le prompt demande à l'assistant de ne citer que ce
// qu'il a lu ; ces vérifications le lui imposent. Elles refusent l'appel avant son
// exécution et expliquent quoi faire — le modèle corrige au lieu de publier une
// référence fausse. C'est d'autant plus nécessaire avec un modèle local : il a moins
// de discipline qu'un grand modèle, et ces règles-là ne se négocient pas.
//
// C'est ce qui sépare ce générateur d'un modèle qui « fait comme si » : une URL
// non consultée ne peut littéralement pas atterrir dans un document.
import { urlsCitables, parId } from '../doc/sources.mjs'
import { normaliserUrl, urlsDuTexte } from '../doc/web.mjs'
import { existe, nomFichier } from '../doc/bibliotheque.mjs'

export class GardeRedaction {
  constructor() {
    /** Sources réellement lues pendant CETTE conversation. */
    this.luesIci = new Set()
  }

  /** Mémorise les sources dès que l'assistant en consulte une. */
  noteToolResult(toolName, brut) {
    if (!brut) return
    const nom = String(toolName || '').replace(/^mcp__redacteur__/, '')
    if (nom !== 'consulter_source' && nom !== 'relire_source') return
    try {
      const data = JSON.parse(brut)
      if (data?.source?.id) this.luesIci.add(data.source.id)
    } catch {}
  }

  #verifierRedaction(i) {
    const ids = Array.isArray(i.sources) ? i.sources.filter(Boolean).map(String) : []
    const markdown = String(i.markdown || '')

    // 1. Les identifiants cités existent-ils vraiment ?
    const inconnus = ids.filter((id) => !parId(id))
    if (inconnus.length) {
      return `Sources inconnues : ${inconnus.join(', ')}. Les identifiants viennent de \`sources_consultees\`, ` +
        'jamais de ta mémoire. Vérifie la liste et rappelle l\'outil.'
    }

    // 2. Une source qui n'a rien rendu ne se cite pas.
    const vides = ids.map((id) => parId(id)).filter((s) => s && s.type !== 'pdf' && !s.caracteres)
    if (vides.length) {
      return `Tu cites ${vides.map((s) => `${s.id} (${s.url})`).join(', ')}, mais cette page n'a rendu aucun texte : ` +
        'tu ne l\'as pas vraiment lue. Retire-la de tes sources, ou trouve la même information ailleurs.'
    }

    // 3. Aucune adresse ne s'invente : tout lien du texte doit avoir été ouvert.
    const citables = urlsCitables()
    const fantomes = urlsDuTexte(markdown).filter((u) => !citables.has(normaliserUrl(u)))
    if (fantomes.length) {
      return `Ce document cite ${fantomes.length} adresse(s) que tu n'as jamais ouverte(s) :\n` +
        `${fantomes.slice(0, 8).map((u) => `- ${u}`).join('\n')}\n` +
        'Ouvre-les avec `consulter_source` — si elles répondent, tu pourras les citer — ou retire-les du texte. ' +
        'Une référence non vérifiée ne part pas dans un document.'
    }

    // 4. Un document de recherche s'appuie sur une lecture faite ici, maintenant.
    if (!ids.length && !i.sans_source && !existe(i.nom || nomFichier(i.titre || ''))) {
      return this.luesIci.size
        ? `Tu as lu ${this.luesIci.size} source(s) dans cette conversation (${[...this.luesIci].join(', ')}) mais tu n'en cites aucune. ` +
          'Renseigne `sources` avec celles qui ont servi.'
        : "Tu n'as consulté aucune source. Cherche (`rechercher_web`), ouvre les pages retenues avec `consulter_source`, " +
          "puis rédige. Si Nicolas a explicitement demandé un texte sans recherche, passe `sans_source: true` — " +
          'le document portera alors un avertissement.'
    }

    if (i.sans_source && this.luesIci.size && !ids.length) {
      return `Tu as pourtant lu ${[...this.luesIci].join(', ')} dans cette conversation. Cite ces sources plutôt ` +
        'que de marquer le document comme non sourcé.'
    }

    // Sur un document NEUF, tout vient de lectures anciennes : rien n'a été vérifié
    // pour ce sujet-là. Sur une nouvelle version d'un document existant, en
    // revanche, une retouche de forme n'a aucune raison de rouvrir les sources —
    // exiger une relecture ferait de chaque correction une expédition.
    const nouvelleVersion = existe(i.nom || nomFichier(i.titre || ''))
    const jamaisIci = ids.filter((id) => !this.luesIci.has(id))
    if (ids.length && !nouvelleVersion && jamaisIci.length === ids.length) {
      return 'Toutes les sources citées viennent de conversations précédentes : rien n\'a été vérifié pour ce ' +
        'document. Rouvre au moins les principales avec `consulter_source` (leur contenu a pu changer) avant d\'enregistrer.'
    }

    if (!markdown.trim()) return 'Le document est vide.'
    return null
  }

  /**
   * Faut-il refuser cet appel ? Rend la raison du refus, en français, ou `null`.
   * Appelée juste avant d'exécuter l'outil.
   */
  verifier(toolName, input) {
    const nom = String(toolName || '').replace(/^mcp__redacteur__/, '')
    const i = input || {}

    switch (nom) {
      case 'rediger_document':
        return this.#verifierRedaction(i)

      case 'consulter_source':
        return /^https?:\/\//i.test(String(i.url || '').trim())
          ? null
          : `« ${i.url} » n'est pas une adresse http(s). Pour un fichier du disque, utilise \`lire_fichier\`.`

      default:
        return null
    }
  }
}
