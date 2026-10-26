// Traduit une demande d'autorisation en français lisible : on doit comprendre ce
// qu'on valide sans lire du JSON.
//
// Les outils de rédaction, eux, composent leur propre carte (voir outils.ts) :
// ils connaissent le document exact et son volume, ce qu'une lecture des
// paramètres ne donnerait pas.

/** Ce que montre la carte de validation : un titre, quelques lignes, un drapeau rouge. */
export interface ResumePermission {
  title: string
  lines: string[]
  danger?: boolean
}

const nomDe = (chemin: unknown): string | undefined => String(chemin).split('/').pop()

export function resumerPermission(toolName: string, input: Record<string, unknown> | null | undefined): ResumePermission | null {
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
