#!/usr/bin/env bash
# Exercises the gateway the way the flax agents runner does, from any machine
# that can reach it: TLS pinned to the gateway's CA under its server name,
# the issuer key, and the five endpoints the runner calls. Prints one line
# per endpoint. The default run makes no upstream model call and costs
# nothing; --live adds one tiny real request with the run key and checks
# that spend is recorded.
#
#   GATEWAY_URL=https://<address>:8443 GATEWAY_SERVER_NAME=<name> GATEWAY_CA=<ca.pem> \
#   LLM_GATEWAY_ISSUER_KEY=<key> GATEWAY_MODEL=<model name> bin/smoke.sh [--live]
#
# Optional: GATEWAY_TEAM (default agents), the team the issuer key belongs to.
set -uo pipefail

usage() {
    echo "usage: GATEWAY_URL GATEWAY_SERVER_NAME GATEWAY_CA LLM_GATEWAY_ISSUER_KEY GATEWAY_MODEL [GATEWAY_TEAM] must be set; $0 [--live]" >&2
    exit 2
}

live=""
case "${1:-}" in
"") ;;
--live) live=1 ;;
*) usage ;;
esac

for v in GATEWAY_URL GATEWAY_SERVER_NAME GATEWAY_CA LLM_GATEWAY_ISSUER_KEY GATEWAY_MODEL; do
    if [ -z "${!v:-}" ]; then
        echo "$v is not set" >&2
        usage
    fi
done
TEAM="${GATEWAY_TEAM:-agents}"
[ -s "$GATEWAY_CA" ] || {
    echo "GATEWAY_CA $GATEWAY_CA is not a file" >&2
    exit 2
}

# The runner opens GATEWAY_URL (often an address) with the TLS server name
# GATEWAY_SERVER_NAME; curl does the same with --connect-to.
hostport="${GATEWAY_URL#https://}"
hostport="${hostport%%/*}"
host="${hostport%%:*}"
port="${hostport##*:}"
[ "$port" = "$host" ] && port=443
BASE="https://$GATEWAY_SERVER_NAME:$port"
connect=(--connect-to "$GATEWAY_SERVER_NAME:$port:$host:$port" --cacert "$GATEWAY_CA" --max-time 20)

failures=0
ok() { echo "ok   $*"; }
bad() {
    echo "FAIL $*"
    failures=$((failures + 1))
}

# call <method> <path> [body]: prints "<status> <body>" of a request with the issuer key.
call() {
    local method="$1" path="$2" body="${3:-}" out
    if [ -n "$body" ]; then
        out="$(curl -s "${connect[@]}" -X "$method" -H "Authorization: Bearer $LLM_GATEWAY_ISSUER_KEY" \
            -H 'Content-Type: application/json' -d "$body" -w '\n%{http_code}' "$BASE$path")"
    else
        out="$(curl -s "${connect[@]}" -X "$method" -H "Authorization: Bearer $LLM_GATEWAY_ISSUER_KEY" \
            -H 'Accept: application/json' -w '\n%{http_code}' "$BASE$path")"
    fi
    printf '%s %s' "${out##*$'\n'}" "${out%$'\n'*}"
}

# message <key>: POST /v1/messages the way the box does (through the forwarder); prints the HTTP status.
message() {
    curl -s -o /dev/null -w '%{http_code}' "${connect[@]}" -H "Authorization: Bearer $1" -H "x-api-key: $1" \
        -H 'anthropic-version: 2023-06-01' -H 'Content-Type: application/json' \
        -d "$(jq -nc --arg m "$GATEWAY_MODEL" '{model: $m, max_tokens: 16, messages: [{role: "user", content: "Reply with the word ok."}]}')" \
        "$BASE/v1/messages"
}

# 1. GET /v1/models/info: the catalog, a map by model name, no key needed.
reply="$(curl -s "${connect[@]}" -w '\n%{http_code}' "$BASE/v1/models/info")"
status="${reply##*$'\n'}"
body="${reply%$'\n'*}"
if [ "$status" = 200 ] && jq -e --arg m "$GATEWAY_MODEL" 'has($m)' <<<"$body" >/dev/null 2>&1; then
    ok "GET /v1/models/info: $(jq 'length' <<<"$body") models, $GATEWAY_MODEL listed (prices $(jq -r --arg m "$GATEWAY_MODEL" '.[$m].pricing | "\(.input) in / \(.output) out per million"' <<<"$body"))"
elif [ "$status" = 200 ]; then
    bad "GET /v1/models/info: $GATEWAY_MODEL is not in the catalog ($(jq -r 'keys | join(", ")' <<<"$body" 2>/dev/null))"
else
    bad "GET /v1/models/info: HTTP $status (TLS, address or server name? $(head -c 200 <<<"$body"))"
    echo "cannot go on"
    exit 1
fi

# 2. GET /team/info: the team's spend and budget, every key with alias and spend.
reply="$(call GET "/team/info?team_id=$TEAM")"
status="${reply%% *}"
body="${reply#* }"
if [ "$status" = 200 ]; then
    ok "GET /team/info: team $TEAM spent \$$(jq -r '.team_info.spend // 0' <<<"$body") of \$$(jq -r '.team_info.max_budget // "unlimited"' <<<"$body") this month, $(jq -r '.keys | length' <<<"$body") keys listed"
else
    bad "GET /team/info: HTTP $status $(head -c 200 <<<"$body")"
fi

# 3. POST /key/generate: a run key exactly as the runner asks for one.
month="$(date -u +%Y-%m)"
alias="$TEAM/smoke/$month/smoke-$(date -u +%Y%m%dT%H%M%SZ)"
request="$(jq -nc --arg t "$TEAM" --arg a "$alias" --arg m "$GATEWAY_MODEL" --arg month "$month" \
    '{team_id: $t, key_alias: $a, models: [$m], max_budget: 0.01, duration: "5m", max_parallel_requests: 2, rpm_limit: 60, key_type: "llm_api", metadata: {job: "smoke", run: $a, month: $month, model: $m}}')"
reply="$(call POST /key/generate "$request")"
status="${reply%% *}"
body="${reply#* }"
key="$(jq -r '.key // empty' <<<"$body" 2>/dev/null)"
if [ "$status" = 200 ] && [ -n "$key" ]; then
    id="$(jq -r '.token // empty' <<<"$body")"
    [ -n "$id" ] || id="$(printf '%s' "$key" | sha256sum | cut -d' ' -f1)"
    ok "POST /key/generate: issued $alias (id ${id:0:12}, expires $(jq -r '.expires // "unknown"' <<<"$body"))"
else
    bad "POST /key/generate: HTTP $status $(head -c 200 <<<"$body")"
    echo "cannot go on without a key"
    exit 1
fi

if [ -n "$live" ]; then
    status="$(message "$key")"
    if [ "$status" = 200 ]; then
        ok "POST /v1/messages (live): one real call to $GATEWAY_MODEL answered 200"
    else
        bad "POST /v1/messages (live): HTTP $status"
    fi
    sleep 12 # LiteLLM writes spend in batches every 10 seconds
fi

# 4. GET /key/info: what the key spent.
reply="$(call GET "/key/info?key=$id")"
status="${reply%% *}"
body="${reply#* }"
spend="$(jq -r '.info.spend // empty' <<<"$body" 2>/dev/null)"
if [ "$status" = 200 ] && [ -n "$spend" ]; then
    if [ -n "$live" ] && ! awk -v s="$spend" 'BEGIN { exit !(s > 0) }'; then
        bad "GET /key/info: spend is \$$spend after a live call (prices missing from the model list?)"
    else
        ok "GET /key/info: key ${id:0:12} spent \$$spend"
    fi
else
    bad "GET /key/info: HTTP $status $(head -c 200 <<<"$body")"
fi

# 5. POST /key/update: block the key, as the runner does when a run ends.
reply="$(call POST /key/update "$(jq -nc --arg k "$key" '{key: $k, blocked: true}')")"
status="${reply%% *}"
body="${reply#* }"
if [ "$status" = 200 ]; then
    refused="$(message "$key")"
    case "$refused" in
    401 | 403) ok "POST /key/update: key blocked; a call with it is refused ($refused) before any upstream call" ;;
    *) bad "POST /key/update: key blocked, but a call with it got HTTP $refused" ;;
    esac
else
    bad "POST /key/update: HTTP $status $(head -c 200 <<<"$body")"
fi

echo
if [ "$failures" -eq 0 ]; then
    echo "all checks passed"
else
    echo "$failures check(s) failed"
    exit 1
fi
