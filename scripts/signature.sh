#!/bin/bash
# Crée, une fois pour toutes, une identité de signature locale pour cette app,
# et écrit son nom sur la sortie standard (« - » = signature ad hoc, en repli).
#
# Pourquoi : Claude Code range ses identifiants dans le trousseau macOS, qui
# autorise un programme d'après sa signature. Une signature « ad hoc » change à
# chaque reconstruction : macOS redemande alors l'autorisation, et tant qu'on n'a
# pas répondu, la session reste bloquée sur « Connexion… ».
#
# Avec ce certificat auto-signé, la signature ne bouge plus d'une version à
# l'autre : le « Toujours autoriser » donné une fois vaut pour toutes les suivantes.
set -euo pipefail

NOM="${1:-Assistant Redacteur (signature locale)}"
TROUSSEAU="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NOM" >/dev/null 2>&1; then
  echo "$NOM"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
MDP="assistant-redacteur"

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$TMP/cle.pem" -out "$TMP/cert.pem" -subj "/CN=$NOM" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

# Le trousseau macOS ne lit pas les PKCS#12 modernes d'OpenSSL 3 : chiffrement et
# empreinte à l'ancienne, et un mot de passe non vide, sinon l'import échoue.
openssl pkcs12 -export -out "$TMP/id.p12" -inkey "$TMP/cle.pem" -in "$TMP/cert.pem" \
  -name "$NOM" -passout "pass:$MDP" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -legacy >/dev/null 2>&1

# -A : codesign se sert de la clé sans redemander à chaque signature.
if security import "$TMP/id.p12" -k "$TROUSSEAU" -P "$MDP" -A >/dev/null 2>&1 \
   && security find-certificate -c "$NOM" >/dev/null 2>&1; then
  echo "$NOM"
else
  echo "-"
fi
