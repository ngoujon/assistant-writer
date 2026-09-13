# Assistant Rédacteur

Une petite app macOS qui ouvre un assistant conversationnel dont le métier tient en
une phrase : **tu donnes un sujet, il rend un document Markdown détaillé et sourcé.**

Il cherche sur le web, **lit vraiment** les pages, rédige, et enregistre un `.md` dans
`~/Assistant Rédacteur`. Il ne fait rien d'autre.

**Le modèle tourne chez toi.** L'app parle à un serveur compatible OpenAI sur ton
réseau — LM Studio, Ollama, llama.cpp — et à rien d'autre : pas de clé d'API, pas de
compte, aucun appel vers un service d'intelligence artificielle. Ce que tu écris et ce
qu'il lit restent sur tes machines. Un interrupteur **hors ligne** coupe même l'accès
au web : plus une seule requête ne sort.

> Fais-moi un rapport complet sur la situation économique de Londres · Où en est la
> réglementation européenne sur l'IA ? · Note de synthèse sur le marché du bois
> construction · Analyse ce que dit cette page : https://…

## Installation

Il te faut d'abord un modèle qui tourne. Dans **LM Studio** : charge un modèle capable
d'appeler des outils (l'app le vérifie et te le dit), puis démarre le serveur local —
c'est l'onglet « Developer », bouton *Start Server*, port 1234 par défaut.

```bash
npm install
npm run install-app      # construit l'app, l'installe dans /Applications, l'épingle au Dock
```

Au premier lancement, l'app va voir le serveur, liste ses modèles et en choisit un.
L'adresse par défaut est `http://localhost:1234/v1` ; elle se change dans les
réglages (⚙), avec le modèle et le mode hors ligne.

> **Autorisation macOS.** Si le serveur tourne sur une *autre* machine du réseau, macOS
> demande une fois l'accès au réseau local. Refusé, l'app ne trouvera aucun modèle :
> Réglages Système ▸ Confidentialité et sécurité ▸ Réseau local.

Un clic l'ouvre, la croix la masque (elle reste dans le Dock), `⌘Q` la quitte.

| Raccourci | Effet |
|---|---|
| `↩` | envoyer |
| `⇧↩` | nouvelle ligne |
| `esc` | refuser la carte en attente, sinon interrompre l'agent |
| `⌘.` | interrompre l'agent |
| `⌘N` | nouvelle conversation |
| `⌘L` | afficher / replier la liste des conversations |
| `⌘D` | afficher / replier la colonne des documents |
| `⌘0` | ramener la fenêtre à un tiers de l'écran |
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

## Deux recherches en même temps

Chaque conversation a **sa propre session**. Deux tournent de front ; les demandes
suivantes attendent leur tour et partent toutes seules dès qu'une place se libère.
Au-delà de deux, la machine rame et les recherches se marchent dessus — c'est un
plafond, pas une limite technique (`MAX_EN_PARALLELE`, dans `src/agent/pool.mjs`).

**Naviguer n'interrompt rien.** Changer de conversation ne fait que changer ce qu'on
regarde : ce qui travaille continue, et son fil se remplit en arrière-plan. Tu le
retrouves complet en y revenant.

| État dans la liste | Ce que ça veut dire |
|---|---|
| **en cours** (point violet) | une recherche tourne dans ce fil, en ce moment |
| **en attente** | la demande est prise, elle part dès qu'une place se libère |
| **inachevée** / **interrompue** | le dernier tour s'est arrêté — bouton ↻ pour reprendre |

Tu peux écrire à un fil qui attend : tes messages s'accumulent et lui arrivent d'un
bloc quand vient son tour. Écrire à un fil qui travaille déjà marche aussi — il en
tient compte à sa prochaine respiration, sans repartir de zéro.

Un fil qui ne travaille plus et qu'on ne regarde plus **rend son processus** ; son
contexte est enregistré, il se reprend sans rien perdre.

## Rien ne reste en plan

Une recherche longue peut s'arrêter en route. Trois filets, dans cet ordre :

1. **Rien n'est coupé par accident.** Chaque fil a sa session : naviguer, en ouvrir un
   autre, en créer un nouveau — rien de tout cela ne touche à une recherche en cours.
2. **Le contexte est sur ton disque.** Chaque étape est enregistrée dans le fichier de
   la conversation. Serveur redémarré, app fermée en pleine recherche, modèle
   déchargé : on reprend la conversation où elle en était au lieu de la recommencer.
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

1. **Chercher et lire sont deux choses.** `rechercher_web` ne rend que des adresses ;
   la seule façon d'ouvrir une page est `consulter_source`, qui la télécharge, la met à
   plat et **l'inscrit à un registre** (identifiant, titre, éditeur, date de
   publication, date de consultation).
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

## Trois colonnes, trois tiers

La fenêtre fait **un tiers de l'écran** et se partage en **trois colonnes égales**.
`⌘0` la remet à cette largeur si tu l'as bougée.

| Colonne (un tiers chacune) | Contenu |
|---|---|
| **Gauche** (`⌘L`) | les conversations, avec recherche dans tout le contenu |
| **Centre** | le fil : ce que tu demandes, ce qu'il lit, ce qu'il publie |
| **Droite** (`⌘D`) | les **documents**, du plus récent au plus ancien, avec leurs versions |

Replier une colonne latérale rend sa place aux deux autres. Les deux **poignées**
entre les colonnes se tirent à la souris pour changer leur largeur — la largeur
choisie est retenue, un double-clic sur la poignée revient au tiers.

**Un document ne s'ouvre jamais tout seul** — ni à la publication, ni sur initiative
de l'assistant. Il apparaît dans la colonne, tu l'ouvres quand tu veux.

**Un document appartient à la conversation qui l'a écrit.** La colonne ne montre que
ceux du fil ouvert ; l'onglet **Tous** ouvre toute la bibliothèque quand tu cherches
un vieux document. Le compteur de la barre de titre, lui, compte toujours l'ensemble.

Chaque document affiche, en toutes lettres : **Ouvrir**, **Exporter…**, puis **Dans le Finder**,
**Supprimer**, et **« 3 versions ▾ »** qui déplie l'historique — **la plus récente en
tête**, chacune avec son propre *Ouvrir* et son *Exporter*.

Dans le fil, la carte du document ne fait plus qu'annoncer ce qui vient d'être publié
et renvoyer vers la colonne.

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

## Il travaille seul

Par défaut, l'assistant **ne demande rien**. Il cherche, lit, écrit, republie et
rend compte à la fin — pas de « veux-tu que je continue ? » au milieu d'une
recherche. Il ne pose une question que si la demande est réellement ambiguë, et
alors avant de partir, pas après.

Ce que ça ne change pas :

- **Les garde-fous de rédaction restent** : ce sont des règles, pas des permissions.
  Un document citant une adresse non lue est refusé, en autonomie comme ailleurs.
- **Tout reste visible** : chaque appel d'outil apparaît dans le fil, dépliable, et
  le journal de bord en garde la trace (`Conversation ▸ Ouvrir le journal de bord`).
- **Rien n'est irréversible** : republier archive au lieu d'écraser, et un document
  supprimé part à la **corbeille du Mac**, pas au néant.

Le réglage **Autonomie** (⚙) revient au mode `prudent` : une carte de validation
s'ouvre alors avant une commande shell, une écriture hors bibliothèque ou un
effacement. Le changer repart sur une conversation neuve.

## Les documents

Un fichier `.md` par sujet, dans `~/Assistant Rédacteur` (changeable dans les
réglages ⚙). Rien de propriétaire : ouvre-les avec n'importe quel éditeur.

> Pourquoi pas `~/Documents` ? macOS y protège l'accès et redemande l'autorisation
> chaque fois que la signature de l'app change — donc à chaque reconstruction. La
> racine du dossier personnel n'est pas surveillée : aucune boîte de dialogue, jamais.
> Tu peux quand même pointer la bibliothèque vers `~/Documents` dans les réglages.

Un document s'ouvre sur ce qu'il dit, pas sur sa fiche technique : titre, résumé,
sommaire. Les informations de production ferment le fichier.

```markdown
# Situation économique de Londres — état des lieux, août 2026

Londres traverse une phase de croissance inégale : la finance tire le PIB pendant
que l'emploi se dégrade à l'est. Ce document fait le point au 29 août 2026.

## Sommaire

- [En bref](#en-bref)
- [Le marché du travail se tend](#le-marché-du-travail-se-tend)
  - [Les services financiers](#les-services-financiers)
- [Ce que les sources ne disent pas](#ce-que-les-sources-ne-disent-pas)

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

---

## À propos de ce document

- **Version 3** — mise à jour le 29 août 2026
- Créé le 21 août 2026
- 9 sources consultées
- Rédigé par l'Assistant Rédacteur (qwen/qwen3.8-27b)

<!-- assistant-redacteur: {"titre":"…","version":3,"sources":9,…} -->
```

Le **sommaire** est composé par l'application à partir des titres réellement présents :
une table des matières ne peut donc pas mentir. Le **commentaire final** est invisible
à la lecture et sert à l'app à retrouver la version d'un document sans le relire.

La section « Ce que les sources ne disent pas » n'est pas décorative : c'est là que
se rangent les trous, les chiffres périmés et les contradictions non tranchées.

## Réglages

| Réglage | Effet |
|---|---|
| **Modèle local** | la liste vient du serveur : ce que ta machine a vraiment sous la main |
| **Serveur** | l'adresse du serveur compatible OpenAI (`http://…:1234/v1`) |
| **Accès web** | `Recherche et lecture autorisées` (défaut) · `Hors ligne — rien ne sort` |
| **SearXNG** | l'adresse d'une instance à interroger au lieu du moteur public |
| **Autonomie** | `Il agit seul` (défaut) · `Me demander avant les actions sensibles` |
| **Profondeur** | `Note` ~1 000 mots / 3-5 sources · `Document` ~2 500 mots / 6-10 · `Dossier` ~5 000 mots / 12+ |
| **Langue** | français ou anglais |
| **Bibliothèque** | le dossier où atterrissent les documents |

Profondeur, langue, autonomie et mode hors ligne s'appliquent **dès le message
suivant**, sans rien perdre de la conversation en cours : les consignes sont
refabriquées à chaque tour.

### La taille de la fenêtre compte

Un modèle local a une fenêtre de contexte étroite, et l'app s'y adapte toute seule :
elle raccourcit les extraits de pages, abrège les vieux résultats d'outils, et garde
un tiers de la fenêtre pour la réponse. Elle le dit aussi dans le fil quand la fenêtre
est trop courte.

**Mets *Context Length* à 32 768 ou plus** au chargement du modèle dans LM Studio.
La raison : dans cette fenêtre doivent tenir en même temps les consignes, les pages
lues, la conversation **et** le document à écrire — et un modèle « qui réfléchit »
(Qwen3, DeepSeek-R1 et consorts) dépense encore un ou deux milliers de jetons à penser
avant chaque appel d'outil. À 16 k, il lit bien mais se fait couper en pleine
rédaction ; à 32 k, il écrit ses documents d'une traite. L'app affiche la fenêtre
détectée sous le menu des modèles.

### Hors ligne

Interrupteur dans les réglages. Plus aucune requête ne sort : ni recherche, ni lecture
de page. L'assistant travaille alors sur les sources **déjà lues** (elles sont
enregistrées sur le disque, texte intégral compris), les documents de la bibliothèque
et les fichiers que tu lui donnes. S'il rédige sans source, le document porte un
avertissement en tête — il ne fait pas semblant d'avoir vérifié.

## Mettre à jour un document

« Reprends mon rapport sur Londres » : il le relit, **rouvre les sources** et publie
une version de plus. Rien n'est écrasé — l'ancienne version reste consultable et
restaurable — donc rien n'est à valider. La date de création est conservée,
`mis_a_jour_le` avance.

## Ce qu'il peut faire d'autre

Il lit les fichiers que tu lui indiques : notes, Markdown, CSV, et les **PDF** (le
texte en est extrait sans dépendance ; un PDF scanné, lui, est signalé comme illisible
plutôt que cité à tort). Il peut aussi repartir d'un document déjà dans la
bibliothèque. Il n'a ni shell ni droit d'écriture ailleurs que dans la bibliothèque :
il n'y a rien d'autre à valider qu'une suppression.

## macOS : signature, trousseau, autorisations

Trois pièges que l'app désamorce, et qu'il vaut mieux connaître si tu la reconstruis :

1. **Le bundle porte un nom sans accent** (`Assistant Redacteur.app`). Un accent dans
   le chemin de l'exécutable ou d'un helper fait planter Electron au lancement —
   `SIGTRAP`, sans message. Le nom accentué revient par `CFBundleDisplayName` : le
   Finder, le Dock et les menus affichent bien « Assistant Rédacteur ».
2. **La signature est stable.** macOS accorde ses autorisations — l'accès au réseau
   local, notamment, sans lequel l'app ne trouve pas ton serveur — d'après la
   signature du programme. Une signature *ad hoc* change à chaque construction : macOS
   redemanderait tout à chaque nouvelle version. `scripts/signature.sh` crée une fois
   un certificat auto-signé local et `build-app.sh` s'en sert — l'autorisation donnée
   une fois vaut pour les versions suivantes.
3. **La bibliothèque évite `~/Documents`**, protégé par macOS (voir plus haut).

Si l'assistant reste muet après une demande, ouvre **Conversation ▸ Ouvrir le journal
de bord** : l'app y écrit son démarrage, l'adresse du serveur, le modèle retenu et la
fenêtre de contexte détectée. Un serveur éteint est dit dans le fil dès l'ouverture de
la conversation ; un serveur qui se fige en cours de route rend la main au bout de
cinq minutes de silence, avec un message qui dit quoi vérifier.

> À savoir : un modèle local prend son temps. Sur une longue conversation, il relit
> tout le contexte avant d'écrire son premier mot — quelques dizaines de secondes par
> étape sont normales. C'est aussi pour ça qu'il publie une première version du
> document tôt, puis l'enrichit.

## Développement

```bash
npm start          # lance l'app depuis les sources
npm test           # extraction, gardes, bibliothèque, outils, conversations, sessions, autonomie, moteur
npm run moteur     # le moteur seul, contre un faux serveur local : outils, contexte, pannes
npm run selftest   # vraie session contre ton serveur : consulte une page et écrit un document
npm run charge     # demande lourde menée jusqu'au bout, avec relance automatique
npx electron scripts/apercu.mjs   # rejoue une conversation type et capture l'interface
```

| Fichier | Rôle |
|---|---|
| `src/main.mjs` | fenêtre, réglages, IPC, cartes de validation |
| `src/agent/moteur.mjs` | le client du serveur local : flux, appels d'outils, pannes |
| `src/agent/session.mjs` | la boucle d'agent : outils, garde-fous, contexte rogné |
| `src/agent/prompt.mjs` | les consignes : méthode, forme du document, ton |
| `src/agent/outils.mjs` | les outils (chercher, consulter, rédiger, bibliothèque) |
| `src/agent/gardes.mjs` | les refus déterministes : on ne cite que ce qu'on a lu |
| `src/agent/pool.mjs` | deux sessions de front, une file d'attente, zéro interruption |
| `src/doc/conversations.mjs` | les fils : titre, recherche, affichage rejouable |
| `src/doc/journal.mjs` | le journal de bord, seule trace quand l'app est lancée du Dock |
| `scripts/signature.sh` | l'identité de signature locale, stable d'une version à l'autre |
| `src/doc/recherche.mjs` | la recherche web, sans clé ni intermédiaire (SearXNG, DuckDuckGo) |
| `src/doc/web.mjs` | téléchargement et mise à plat des pages |
| `src/doc/pdf.mjs` | extraction du texte d'un PDF, sans dépendance |
| `src/doc/sources.mjs` | le registre des sources consultées |
| `src/doc/bibliotheque.mjs` | les fichiers `.md` : en-tête, corps, bibliographie |
| `scripts/test-gardes.mjs` | les douze cas que le garde-fou doit refuser ou laisser passer |

Les données (registre, texte des sources, réglages) vivent dans
`~/Library/Application Support/Assistant Rédacteur`. Les documents, eux, restent
chez toi, dans `~/Documents`.
