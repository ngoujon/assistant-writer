// Emplacement des données de l'assistant. Les mêmes chemins qu'Electron
// (`app.getPath('userData')` pour un productName « Assistant Rédacteur »), afin que
// les scripts hors Electron (tests, selftest) lisent exactement la même config.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Sans accent, pour coller exactement au dossier qu'Electron choisit lui-même
// (`app.getPath('userData')`, dérivé du productName ASCII du bundle).
const APP_DIR = 'Assistant Redacteur'

function defaultRoot() {
  if (process.env.REDACTEUR_DATA_DIR) return path.resolve(process.env.REDACTEUR_DATA_DIR)
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR)
  }
  return path.join(os.homedir(), '.config', APP_DIR)
}

/**
 * La bibliothèque est faite pour être ouverte à la main : elle vit à la racine du
 * dossier personnel, pas dans les données de l'app.
 *
 * Pas dans ~/Documents, malgré l'évidence : macOS y protège l'accès et redemande
 * l'autorisation dès que la signature de l'app change — c'est-à-dire à chaque
 * reconstruction. La racine du dossier personnel n'est pas surveillée : plus une
 * seule boîte de dialogue. Nicolas peut toujours choisir ~/Documents dans les
 * réglages s'il préfère, et l'autoriser une fois.
 */
function defaultBibliotheque() {
  if (process.env.REDACTEUR_BIBLIOTHEQUE) return path.resolve(process.env.REDACTEUR_BIBLIOTHEQUE)
  return path.join(os.homedir(), 'Assistant Rédacteur')
}

/** Le sous-dossier où s'empilent les versions précédentes de chaque document. */
export const VERSIONS = 'Versions'

let root = defaultRoot()
let bibliotheque = defaultBibliotheque()

/** Electron appelle ceci au démarrage avec son propre userData. */
export function setDataRoot(dir) {
  root = dir
  ensureDirs()
}

/** Nicolas peut ranger sa bibliothèque où il veut (réglages ⚙). */
export function setBibliotheque(dir) {
  if (!dir) return
  bibliotheque = path.resolve(dir)
  ensureDirs()
}

export function dataRoot() { return root }
export function bibliothequeParDefaut() { return defaultBibliotheque() }

export const P = {
  /** Un fichier par conversation : métadonnées et fil rejouable. */
  conversations: () => path.join(root, 'conversations'),
  conversation: (id) => path.join(root, 'conversations', `${id}.json`),
  /** Registre des pages réellement consultées : la seule base citable. */
  registre: () => path.join(root, 'sources', 'registre.json'),
  /** Texte brut de chaque source, conservé pour pouvoir la relire sans réseau. */
  source: (id) => path.join(root, 'sources', `${id}.txt`),
  /** Fichiers téléchargés qui ne sont pas du texte (PDF…). */
  pieces: () => path.join(root, 'sources', 'pieces'),
  bibliotheque: () => bibliotheque,
  document: (nom) => path.join(bibliotheque, nom),
  /** Les versions précédentes d'un document, rangées à côté de lui. */
  versions: (nom) => path.join(bibliotheque, VERSIONS, String(nom).replace(/\.md$/, '')),
}

/** Le dossier de données : jamais protégé, on peut le créer n'importe quand. */
export function ensureDonnees() {
  for (const dir of [root, path.join(root, 'sources'), P.pieces(), P.conversations()]) {
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  }
}

export function ensureDirs() {
  ensureDonnees()
  try { fs.mkdirSync(bibliotheque, { recursive: true }) } catch {}
}

// À l'import, on ne touche qu'au dossier de données. La bibliothèque vit dans
// ~/Documents, un dossier que macOS protège : la première tentative d'accès
// déclenche une demande d'autorisation, qu'une app doit poser fenêtre ouverte —
// avant `app.whenReady()`, le système tue le processus au lieu de demander.
ensureDonnees()
