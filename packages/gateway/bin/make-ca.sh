#!/usr/bin/env bash
# Writes a private CA and a server certificate for the gateway with openssl:
# ECDSA P-256 keys, the CA valid 10 years, the server certificate 2 years,
# issued for exactly one name (its SAN). Nothing here ever leaves the host
# except ca.pem, which the workspace keeps as gateway.yml ca.
#
#   bin/make-ca.sh <server-name> <out-dir> [org-name]
#
# Writes into <out-dir>: ca.pem, ca-key.pem, server.pem, server-key.pem.
# Refuses to overwrite: move the old files away first (and keep ca-key.pem,
# it signs the next server certificate).
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
    echo "usage: $0 <server-name> <out-dir> [org-name]" >&2
    exit 2
fi
name="$1"
out="$2"
org="${3:-llm-gateway}"

case "$name" in
*[!a-z0-9.-]* | "" | -* | .* | *.)
    echo "server name must be a lowercase DNS name, got '$name'" >&2
    exit 2
    ;;
esac

mkdir -p "$out"
for f in ca.pem ca-key.pem server.pem server-key.pem; do
    if [ -e "$out/$f" ]; then
        echo "$out/$f exists; move the old files away first" >&2
        exit 1
    fi
done

umask 077
work="$(mktemp -d "$out/.make-ca.XXXXXX")"
trap 'rm -rf "$work"' EXIT

openssl ecparam -name prime256v1 -genkey -noout -out "$out/ca-key.pem"
openssl req -x509 -new -key "$out/ca-key.pem" -sha256 -days 3650 \
    -subj "/O=$org/CN=$org CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -out "$out/ca.pem"

openssl ecparam -name prime256v1 -genkey -noout -out "$out/server-key.pem"
openssl req -new -key "$out/server-key.pem" -sha256 \
    -subj "/O=$org/CN=$name" -out "$work/server.csr"
cat >"$work/server.ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:$name
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EXT
openssl x509 -req -in "$work/server.csr" -CA "$out/ca.pem" -CAkey "$out/ca-key.pem" \
    -CAcreateserial -CAserial "$work/ca.srl" -sha256 -days 730 \
    -extfile "$work/server.ext" -out "$out/server.pem" 2>/dev/null

# Certificates are public; keys stay 0600 (the caddy container reads the
# server key as the runtime user, so run this as that user).
chmod 0644 "$out/ca.pem" "$out/server.pem"

openssl verify -CAfile "$out/ca.pem" "$out/server.pem" >/dev/null
echo "wrote $out/ca.pem (CA, 10 years), $out/server.pem and $out/server-key.pem for $name (2 years), $out/ca-key.pem (keep it to renew)"
echo "copy $out/ca.pem to the workspace as gateway.yml ca; never copy the keys anywhere"
