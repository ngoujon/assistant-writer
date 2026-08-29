// Un journal de bord, court et permanent.
//
// Lancée depuis le Dock, l'app n'a pas de terminal : sans trace écrite, un
// démarrage qui coince ne laisse rien à regarder. On garde donc les dernières
// lignes dans le dossier de données — jamais de contenu de document, seulement le
// déroulé technique.
import fs from 'node:fs'
import path from 'node:path'
import { dataRoot } from './paths.mjs'

const MAX_OCTETS = 120_000

let fichier = null
function chemin() {
  if (!fichier) fichier = path.join(dataRoot(), 'journal.log')
  return fichier
}

export function tracer(...morceaux) {
  const ligne = `${new Date().toISOString()} ${morceaux
    .map((m) => (typeof m === 'string' ? m : safe(m)))
    .join(' ')}\n`
  try {
    const f = chemin()
    fs.mkdirSync(path.dirname(f), { recursive: true })
    // Rotation par troncature : on ne garde que la moitié récente.
    if ((fs.statSync(f).size || 0) > MAX_OCTETS) {
      const tout = fs.readFileSync(f, 'utf8')
      fs.writeFileSync(f, tout.slice(-MAX_OCTETS / 2))
    }
  } catch {}
  try { fs.appendFileSync(chemin(), ligne) } catch {}
}

export function cheminJournal() { return chemin() }

function safe(v) {
  try { return JSON.stringify(v).slice(0, 600) } catch { return String(v) }
}
