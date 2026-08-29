# Assistant Rédacteur

Une petite app macOS qui ouvre un assistant conversationnel — un agent Claude Code
déguisé en fenêtre — dont le métier tient en une phrase : **tu donnes un sujet, il
rend un document Markdown détaillé et sourcé.**

C'est « Claude Code lancé dans un dossier », mais le dossier c'est ta bibliothèque :
il cherche sur le web, **lit vraiment** les pages, rédige, et enregistre un `.md`
dans `~/Assistant Rédacteur`. Il ne fait rien d'autre.

> Fais-moi un rapport complet sur la situation économique de Londres · Où en est la
> réglementation européenne sur l'IA ? · Note de synthèse sur le marché du bois
> construction · Analyse ce que dit cette page : https://…

## Installation

```bash
npm install
npm run install-app      # construit l'app, l'installe dans /Applications, l'épingle au Dock
```

Un clic l'ouvre, la croix la masque (elle reste dans le Dock), `⌘Q` la quitte.

| Raccourci | Effet |
|---|---|
| `↩` | envoyer |
| `⇧↩` | nouvelle ligne |
| `esc` | refuser la carte en attente, sinon interrompre l'agent |
| `⌘.` | interrompre l'agent |
| `⌘N` | nouvelle conversation |
| `⌘L` | afficher / replier la liste des conversations |
| `⌘⇧O` | ouvrir la bibliothèque dans le Finder |

## Plusieurs sujets en parallèle

Un document par conversation. Le `+` en ouvre une nouvelle et découvre la **barre
latérale** : la liste des fils, avec une **recherche** qui fouille les titres, ce que
tu as demandé, ce qui t'a été répondu, les documents produits et les adresses lues.

Chaque fil garde son titre (la première demande, remplacée par le titre du document
dès qu'il en sort un — double-clic pour le renommer), son contexte côté modèle, et
son affichage : revenir dessus des semaines plus tard retrouve l'écran tel qu'il
était, sources et cartes de document comprises. `×` supprime le fil ; les documents
qu'il a produits, eux, restent dans la bibliothèque.

Dans la liste, un fil qui travaille en ce moment porte un point violet **en cours** ;
un fil dont le dernier tour s'est arrêté avant la fin est marqué **inachevée** ou
**interrompue** — c'est ce qu'on veut repérer d'un coup d'œil pour y revenir.

Le titre du fil est **écrit par l'assistant** dès qu'il a compris la demande (trois à
sept mots sur le sujet, pas ta formulation). Un titre que tu poses toi-même par
double-clic est définitif : plus rien ne le recouvre.

## Rien ne reste en plan

Une recherche longue peut s'arrêter en route. Trois filets, dans cet ordre :

1. **On ne coupe plus le travail par accident.** Rouvrir le fil déjà ouvert ne relance
   plus la session — c'était le vrai bug : chaque clic dans la liste tuait la recherche
   en cours, sans rien dire. Quitter un fil qui travaille le marque désormais
   **interrompu** au lieu de le perdre.
2. **Reconnexion automatique.** Si Claude Code s'arrête en cours de route, l'app
   rebranche la conversation sur son contexte (deux tentatives) et le dit dans le fil.
3. **↻ Reprendre**, à un clic — dans le fil quand un tour s'arrête, et sur la ligne de
   tout fil resté en plan dans la liste. Ça rebranche la session sur son contexte et
   redemande la suite, sans refaire ce qui est déjà fait.

Et surtout : l'assistant **publie une première version tôt**, dès qu'il a de quoi tenir
un document utile, puis l'enrichit version après version. Une recherche coupée laisse
donc toujours quelque chose de lisible derrière elle.

À l'ouverture, l'app rouvre le dernier fil travaillé.

## Ce qui garantit les sources

Un modèle de langage sait produire une bibliographie crédible sans avoir rien lu.
L'app rend ça impossible, par construction :

1. **`WebFetch` est désactivé.** La seule façon d'ouvrir une page est l'outil
   `consulter_source`, qui la télécharge, la met à plat et **l'inscrit à un registre**
   (identifiant, titre, éditeur, date de publication, date de consultation).
2. **Un garde-fou déterministe** (`src/agent/gardes.mjs`) inspecte chaque document
   avant enregistrement. Toute adresse `http(s)` présente dans le texte et absente du
   registre fait **refuser** l'appel, avec la liste des coupables. Le modèle n'a pas
   le choix : il ouvre la page, ou il retire la référence.
3. **La bibliographie n'est pas écrite par le modèle.** Il passe des identifiants
   (`s1`, `s4`…), l'app compose la section « Sources » à partir du registre. Un titre
   de rapport ne peut donc pas être approximatif, ni une date de consultation inventée.
4. Une page qui n'a **rien rendu** (mur payant, site tout en JavaScript) ne compte pas
   comme lue : la citer est refusé.
5. Ne citer que des lectures de conversations précédentes est refusé aussi — sur un
   sujet qui bouge, les sources se rouvrent.

Le reste — recouper deux chiffres contradictoires, préférer une source primaire,
signaler une donnée trop vieille — relève des consignes (`src/agent/prompt.mjs`), pas
du code. Les garde-fous couvrent ce qui est vérifiable mécaniquement.

## Retoucher, versionner, exporter

Le document n'est pas un point final. « Ajoute une partie sur l'immobilier », « la
section 3 est trop longue », « refais l'intro » : l'assistant **republie le document**,
et chaque republication crée une **nouvelle version**.

- L'ancienne version part dans `Versions/<nom-du-document>/v2.md`, à côté du document.
  **Rien n'est écrasé** — donc rien à valider : tu retouches autant que tu veux.
- La carte du document affiche `v3` et un bouton **Versions** : chaque version s'ouvre
  et s'exporte séparément.
- « Reviens à la version d'avant » : l'assistant la remet en place, sous un nouveau
  numéro. L'état d'où l'on revient reste consultable.
- **Exporter…** ouvre l'enregistreur macOS et dépose une copie où tu veux
  (Téléchargements par défaut). L'original ne bouge pas de la bibliothèque.

La seule action qui demande encore une confirmation est la **suppression** d'un
document — elle emporte tout son historique.

## Les documents

Un fichier `.md` par sujet, dans `~/Assistant Rédacteur` (changeable dans les
réglages ⚙). Rien de propriétaire : ouvre-les avec n'importe quel éditeur.

> Pourquoi pas `~/Documents` ? macOS y protège l'accès et redemande l'autorisation
> chaque fois que la signature de l'app change — donc à chaque reconstruction. La
> racine du dossier personnel n'est pas surveillée : aucune boîte de dialogue, jamais.
> Tu peux quand même pointer la bibliothèque vers `~/Documents` dans les réglages.

```markdown
---
titre: "Situation économique de Londres — état des lieux, août 2026"
sujet: "rapport complet sur l'économie londonienne"
cree_le: 2026-08-29
mis_a_jour_le: 2026-08-29
sources: 9
version: 3
modele: claude-opus-5
redige_par: "Assistant Rédacteur"
---

# Situation économique de Londres — état des lieux, août 2026

## En bref
- Croissance de **1,4 %** au T2 2026 ([ONS](https://…)), portée à 70 % par la finance.
…

## Ce que les sources ne disent pas
…

---

## Sources

1. **GDP, UK regions and countries** — ONS — publié le 11 juin 2026
   <https://www.ons.gov.uk/…>
   *consultée le 29 août 2026*
```

La section « Ce que les sources ne disent pas » n'est pas décorative : c'est là que
se rangent les trous, les chiffres périmés et les contradictions non tranchées.

## Réglages

| Réglage | Effet |
|---|---|
| **Modèle** | Opus 5 par défaut. Sonnet 5 va plus vite, Haiku 4.5 est expéditif. |
| **Profondeur** | `Note` ~1 000 mots / 3-5 sources · `Document` ~2 500 mots / 6-10 · `Dossier` ~5 000 mots / 12+ |
| **Langue** | français ou anglais |
| **Ouvrir une fois écrit** | ouvre le `.md` dans ton éditeur dès qu'il est prêt |
| **Bibliothèque** | le dossier où atterrissent les documents |

Changer la profondeur ou la langue repart sur une conversation neuve : ces règles
vivent dans les consignes de l'assistant.

## Mettre à jour un document

« Reprends mon rapport sur Londres » : il le relit, **rouvre les sources**, réécrit,
et demande confirmation avant d'écraser l'ancienne version. La date de création est
conservée, `mis_a_jour_le` avance.

## Ce qu'il peut faire d'autre

Il tourne sur ta machine avec Bash, la lecture/écriture de fichiers et la recherche
web. Il peut donc lire un PDF que tu lui donnes, dépouiller un CSV, ou partir d'un
document déjà dans la bibliothèque. Toute action en dehors de la bibliothèque
(commande shell, écriture d'un fichier ailleurs) passe par une carte de validation.

## macOS : signature, trousseau, autorisations

Trois pièges que l'app désamorce, et qu'il vaut mieux connaître si tu la reconstruis :

1. **Le bundle porte un nom sans accent** (`Assistant Redacteur.app`). Un accent dans
   le chemin de l'exécutable ou d'un helper fait planter Electron au lancement —
   `SIGTRAP`, sans message. Le nom accentué revient par `CFBundleDisplayName` : le
   Finder, le Dock et les menus affichent bien « Assistant Rédacteur ».
2. **La signature est stable.** Claude Code garde ses identifiants dans le trousseau
   macOS, qui autorise un programme d'après sa signature. Une signature *ad hoc*
   change à chaque construction : macOS redemanderait l'autorisation à chaque
   nouvelle version. `scripts/signature.sh` crée une fois un certificat auto-signé
   local et `build-app.sh` s'en sert — le « Toujours autoriser » donné une fois vaut
   pour toutes les versions suivantes.
3. **La bibliothèque évite `~/Documents`**, protégé par macOS (voir plus haut).

Si l'assistant reste muet après une demande, ouvre **Conversation ▸ Ouvrir le journal
de bord** : l'app y écrit son démarrage et la sortie d'erreur de Claude Code. Au bout
de 30 secondes sans réponse, elle le dit aussi dans le fil.

> À savoir : en entrée continue, Claude Code n'envoie **rien** — pas même son message
> d'initialisation — tant qu'il n'a pas reçu une première demande. La fenêtre affiche
> donc « prêt » dès l'ouverture ; la session s'établit vraiment au premier message.

## Développement

```bash
npm start          # lance l'app depuis les sources
npm test           # extraction HTML, garde-fous, bibliothèque, validations, conversations
npm run selftest   # vraie session agent : consulte une page et écrit un document
npm run charge     # demande lourde menée jusqu'au bout, avec relance automatique
npx electron scripts/apercu.mjs   # rejoue une conversation type et capture l'interface
```

| Fichier | Rôle |
|---|---|
| `src/main.mjs` | fenêtre, réglages, IPC, cartes de validation |
| `src/agent/session.mjs` | la boucle Claude Agent SDK |
| `src/agent/prompt.mjs` | les consignes : méthode, forme du document, ton |
| `src/agent/outils.mjs` | les outils MCP (consulter, rédiger, bibliothèque) |
| `src/agent/gardes.mjs` | les refus déterministes : on ne cite que ce qu'on a lu |
| `src/doc/conversations.mjs` | les fils : titre, recherche, affichage rejouable |
| `src/doc/journal.mjs` | le journal de bord, seule trace quand l'app est lancée du Dock |
| `scripts/signature.sh` | l'identité de signature locale, stable d'une version à l'autre |
| `src/doc/web.mjs` | téléchargement et mise à plat des pages |
| `src/doc/sources.mjs` | le registre des sources consultées |
| `src/doc/bibliotheque.mjs` | les fichiers `.md` : en-tête, corps, bibliographie |
| `scripts/test-gardes.mjs` | les douze cas que le garde-fou doit refuser ou laisser passer |

Les données (registre, texte des sources, réglages) vivent dans
`~/Library/Application Support/Assistant Rédacteur`. Les documents, eux, restent
chez toi, dans `~/Documents`.
