// Ce que l'interface reçoit du processus principal, et l'API que le preload lui
// expose (voir src/preload.cts). Le renderer n'importe rien de Node : ces types
// décrivent la forme des messages, pas leur provenance.

export type Portee = 'conversation' | 'tous'

export type StatutFil = 'en_cours' | 'en_attente' | 'interrompu' | 'incomplet' | 'termine'

export interface Reglages {
  model: string
  profondeur: string
  langue: string
  autonomie: string
  barreVisible: boolean
  docsVisible: boolean
  largeurBarre: number | null
  largeurDocs: number | null
  porteeDocs: Portee
}

/** Une fiche de la colonne des documents. */
export interface DocumentResume {
  nom: string
  titre: string
  mots: number
  sources: number
  version: number
  mis_a_jour_le: string
}

/** Le document qu'un tour vient d'enregistrer. */
export interface DocumentProduit {
  nom: string
  titre: string
  mots?: number
  sources_citees?: number
  version?: number
  remplace?: boolean
}

export interface VersionDocument {
  numero: number
  courante: boolean
  mots: number
  sources: number
  date: string
}

export interface ConversationResume {
  id: string
  titre: string
  maj_le: string
  documents: number
  messages?: number
  sansTitre?: boolean
  statut?: StatutFil | null
}

export interface SourceLue {
  id: string
  titre?: string
  url: string
}

/** Un fil enregistré, rejoué à l'ouverture. */
export type EvenementEnregistre =
  | { k: 'user'; texte: string }
  | { k: 'texte'; texte: string }
  | { k: 'outil'; nom: string; arg: string }
  | { k: 'source'; id: string; titre?: string; url: string }
  | { k: 'document'; nom: string; titre: string; mots?: number; sources?: number; version?: number; remplace?: boolean }
  | { k: 'note'; texte: string; kind?: string }

export interface ResumePermission {
  title?: string
  lines?: string[]
  danger?: boolean
}

export interface ReponsePermission {
  behavior: 'allow' | 'deny'
  always?: boolean
  message?: string
}

export type EvenementAgent =
  | { k: 'ready'; sessionId?: string; model?: string; outils: string }
  | { k: 'documents'; documents: DocumentResume[]; portee?: Portee; total?: number }
  | { k: 'status'; state: 'idle' | 'thinking' | 'connecting' }
  | { k: 'turn-start' }
  | { k: 'queued' }
  | { k: 'text-start' }
  | { k: 'text-delta'; text: string }
  | { k: 'thinking-start' }
  | { k: 'thinking-delta'; text: string }
  | { k: 'tool-use'; id: string; name: string; input: unknown }
  | { k: 'tool-result'; id: string; name: string; ok: boolean; preview: string }
  | { k: 'source'; source: SourceLue; deja_lue?: boolean }
  | { k: 'document'; document: DocumentProduit }
  | {
    k: 'permission'
    id: string
    origine: string | null
    toolName: string
    title?: string
    displayName?: string
    subtitle?: string
    reason?: string
    summary?: ResumePermission | null
    hint?: string
    allowAlways: boolean
    input: unknown
  }
  | { k: 'result'; isError: boolean; text: string; reprenable: boolean; costUsd?: number; durationMs?: number }
  | { k: 'interrupted' }
  | { k: 'note'; text: string }
  | { k: 'reprise-possible' }
  | { k: 'resumed' }
  | { k: 'titre'; titre: string }
  | { k: 'conversation'; id: string; titre: string | null; statut: StatutFil | null; evenements: EvenementEnregistre[] }
  | { k: 'conversations'; liste: ConversationResume[]; courante: string | null }
  | { k: 'basculer-barre' }
  | { k: 'basculer-docs' }
  | { k: 'error'; message: string }

export interface EtatInitial {
  config: Reglages
  bibliotheque: string
  documents: DocumentResume[]
  totalDocuments: number
  conversations: ConversationResume[]
  version: string
}

export interface ApiRedacteur {
  init(): Promise<EtatInitial>
  send(text: string): void
  interrupt(): void
  setConfig(patch: Partial<Reglages>): void
  replyPermission(id: string, answer: ReponsePermission): void
  conv: {
    list(recherche?: string): Promise<ConversationResume[]>
    create(): Promise<string>
    open(id: string): Promise<string>
    resume(id: string | null): Promise<string | null>
    rename(id: string, titre: string): Promise<ConversationResume[]>
    remove(id: string): Promise<ConversationResume[]>
  }
  docs: {
    list(portee?: Portee): Promise<DocumentResume[]>
    sources(): Promise<unknown[]>
    open(nom: string): void
    reveal(nom: string): void
    remove(nom: string): Promise<DocumentResume[]>
    versions(nom: string): Promise<VersionDocument[]>
    openVersion(nom: string, numero: number): void
    export(nom: string, numero?: number): Promise<{ chemin?: string; annule?: boolean; erreur?: string }>
  }
  choisirBibliotheque(): Promise<{ bibliotheque: string; documents: DocumentResume[] }>
  openBibliotheque(): void
  openExternal(url: string): void
  onEvent(cb: (evt: EvenementAgent) => void): () => void
}

declare global {
  interface Window {
    redacteur: ApiRedacteur
  }
}
