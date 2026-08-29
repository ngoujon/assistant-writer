// Traduit une demande d'autorisation en français lisible : on doit comprendre ce
// qu'on valide sans lire du JSON.
//
// Les outils de rédaction, eux, composent leur propre carte (voir outils.mjs) :
// ils connaissent le document exact et son volume, ce qu'une lecture des
// paramètres ne donnerait pas.

const nomDe = (chemin) => String(chemin).split('/').pop()

export function resumerPermission(toolName, input) {
  const i = input || {}
  switch (toolName) {
    case 'Bash': {
      const cmd = String(i.command || '')
      if (!cmd) return null
      return {
        title: 'Exécuter une commande sur ton Mac ?',
        lines: [cmd],
        danger: /\brm\b|\bsudo\b|\bkillall\b|\bdd\b|\bmv\b/.test(cmd),
      }
    }
    case 'Write':
      return i.file_path
        ? { title: `Écrire le fichier ${nomDe(i.file_path)} ?`, lines: [String(i.file_path)] }
        : null
    case 'Edit':
      return i.file_path
        ? { title: `Modifier le fichier ${nomDe(i.file_path)} ?`, lines: [String(i.file_path)] }
        : null
    default:
      return null
  }
}
