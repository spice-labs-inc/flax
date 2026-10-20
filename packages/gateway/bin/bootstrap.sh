#!/usr/bin/env bash
# Sets the gateway up from a workspace's models.yml and the stack's .env.
#
#   bin/bootstrap.sh models <models.yml | models.json>
#       Writes models/model_list.yaml (LiteLLM's model list: one entry per
#       confirmed model, priced per token, routed to the provider host) and
#       models/models-info.json (the catalog Caddy serves at /v1/models/info)
#       from the workspace catalog. Run it before the first `docker compose
#       up` and again whenever models.yml changes (then recreate litellm and
#       caddy). models.yml is read with yq, else with node and the yaml
#       package of packages/agents; a models.json (the same list as JSON)
#       needs neither.
#
#   bin/bootstrap.sh team [--issue-runner-key]
#       With the stack up: creates the LiteLLM team (its models are the
#       catalog's, its budget MONTHLY_BUDGET_USD per calendar month) or, when
#       it exists, brings its model list up to date. With --issue-runner-key,
#       also issues a team service account key (the runner's
#       LLM_GATEWAY_ISSUER_KEY) and prints it once; without the flag nothing
#       is issued, so rerunning never rotates the key by surprise.
#
# Settings, all optional: STACK_DIR (where docker-compose.yml and .env are;
# default: this package), ADMIN (LiteLLM's admin site; default
# http://127.0.0.1:4000), GATEWAY_TEAM (default agents), YAML_PKG (the yaml
# package directory for node).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="${STACK_DIR:-$(cd "$here/.." && pwd)}"
ADMIN="${ADMIN:-http://127.0.0.1:4000}"
TEAM="${GATEWAY_TEAM:-agents}"
YAML_PKG="${YAML_PKG:-$here/../../agents/node_modules/yaml}"
MODELS_DIR="$STACK_DIR/models"
PERMISSIONS='["/key/generate","/key/update","/key/info","/key/list","/key/health"]'

usage() {
    echo "usage: $0 models <models.yml | models.json>" >&2
    echo "       $0 team [--issue-runner-key]" >&2
    exit 2
}

die() {
    echo "$*" >&2
    exit 1
}

# load_env: exports every variable of $STACK_DIR/.env.
load_env() {
    [ -f "$STACK_DIR/.env" ] || die "$STACK_DIR/.env is missing; copy the variables from README.md"
    set -a
    # shellcheck disable=SC1091
    . "$STACK_DIR/.env"
    set +a
}

# need VAR...: fails when a variable is unset or empty.
need() {
    local v
    for v in "$@"; do
        [ -n "${!v:-}" ] || die "$v is not set in $STACK_DIR/.env"
    done
}

# to_json <file>: prints the workspace model list as JSON.
to_json() {
    local file="$1"
    [ -f "$file" ] || die "$file is not a file"
    case "$file" in
    *.json)
        cat "$file"
        ;;
    *)
        if command -v yq >/dev/null 2>&1; then
            yq -o=json '.' "$file"
        elif command -v node >/dev/null 2>&1 && [ -f "$YAML_PKG/package.json" ]; then
            node -e '
const yaml = require(process.argv[1]);
const fs = require("node:fs");
process.stdout.write(JSON.stringify(yaml.parse(fs.readFileSync(process.argv[2], "utf8"))));
' "$YAML_PKG" "$file"
        else
            die "neither yq nor node with the yaml package ($YAML_PKG) is here; convert it first: yq -o=json . $file > models.json"
        fi
        ;;
    esac
}

# per_token <usd per million>: the same price per token, as a plain decimal
# (no exponent: the model list is YAML, and YAML reads 1e-06 as a string).
per_token() {
    awk -v p="$1" 'BEGIN { s = sprintf("%.12f", p / 1000000); sub(/0+$/, "", s); sub(/\.$/, ".0", s); print s }'
}

write_models() {
    local file="$1" json
    json="$(to_json "$file")"
    # The checks the runner itself makes on models.yml: a list of objects with
    # id, provider and two prices; names must be unique once the provider
    # prefix is dropped (the gateway routes by that name).
    jq -e '
        def name: .id | if contains("/") then sub("^[^/]*/"; "") else . end;
        if type != "array" then error("the catalog is not a list") else . end
        | if length == 0 then error("the catalog lists no model") else . end
        | if any(.[]; type != "object" or (.id | type) != "string" or (.provider | type) != "string"
                 or (.usd_per_million_input | type) != "number" or (.usd_per_million_output | type) != "number")
          then error("every model needs id, provider, usd_per_million_input and usd_per_million_output") else . end
        | map(select(.confirmed != false)) as $m
        | if ($m | length) == 0 then error("every model is marked confirmed: false") else . end
        | if ($m | map(name) | unique | length) != ($m | length) then error("two models share a name after the provider prefix") else . end
        | ($m | map(select(.provider != "anthropic") | .provider) | unique) as $others
        | if ($others | length) > 1 then error("more than one provider besides anthropic (\($others | join(", "))); this stack routes one provider host") else . end
        | "ok"' <<<"$json" >/dev/null || die "$file: not a usable model catalog"

    mkdir -p "$MODELS_DIR"
    local tmp_list="$MODELS_DIR/.model_list.yaml.tmp" tmp_info="$MODELS_DIR/.models-info.json.tmp"

    # LiteLLM's model list. Every model is reached over the Anthropic Messages
    # API (anthropic/<name>) at the provider's host; the forwarder relays only
    # that API. Cache prices default to the input price.
    {
        echo "# Written by bin/bootstrap.sh models from $(basename "$file"); do not edit, rerun instead."
        echo "model_list:"
        jq -r '.[] | select(.confirmed != false)
            | [ (.id | if contains("/") then sub("^[^/]*/"; "") else . end), .provider,
                .usd_per_million_input, .usd_per_million_output, ((.thinking // []) | join(",")) ]
            | @tsv' <<<"$json" |
            while IFS=$'\t' read -r name provider in_price out_price thinking; do
                local base key input output reasoning
                if [ "$provider" = anthropic ]; then
                    base="https://api.anthropic.com"
                    key="os.environ/ANTHROPIC_API_KEY"
                else
                    base="https://$PROVIDER_API_HOST"
                    key="os.environ/PROVIDER_API_KEY"
                fi
                input="$(per_token "$in_price")"
                output="$(per_token "$out_price")"
                case "$thinking" in
                "" | *low* | *medium* | *high*) reasoning=true ;;
                *) reasoning=false ;;
                esac
                printf '  - model_name: "%s"\n' "$name"
                printf '    litellm_params:\n'
                printf '      model: "anthropic/%s"\n' "$name"
                printf '      api_base: "%s"\n' "$base"
                printf '      api_key: "%s"\n' "$key"
                printf '    model_info:\n'
                printf '      input_cost_per_token: %s\n' "$input"
                printf '      output_cost_per_token: %s\n' "$output"
                printf '      cache_read_input_token_cost: %s\n' "$input"
                printf '      cache_creation_input_token_cost: %s\n' "$input"
                printf '      supports_reasoning: %s\n' "$reasoning"
                printf '      supports_adaptive_thinking: %s\n' "$reasoning"
            done
    } >"$tmp_list"

    # The catalog: a map by gateway model name in the shape the Pi provider
    # plugin reads. Thinking levels of models.yml become the plugin's
    # reasoning levels (off: none, xhigh: max). models/overrides.json, when
    # present, is merged over it by model name (context windows and the like).
    local overrides="$MODELS_DIR/overrides.json"
    [ -f "$overrides" ] || overrides=/dev/null
    jq --slurpfile over <(jq '.' "$overrides" 2>/dev/null || echo '{}') '
        def name: .id | if contains("/") then sub("^[^/]*/"; "") else . end;
        def level: {off: "none", low: "low", medium: "medium", high: "high", xhigh: "max"}[.];
        def levels: if .thinking == null then ["none", "low", "medium", "high", "max"] else (.thinking | map(level)) end;
        [ .[] | select(.confirmed != false)
          | { key: name,
              value: {
                name: name,
                display_name: name,
                pricing: { input: .usd_per_million_input, output: .usd_per_million_output },
                capabilities: {
                  supports_tools: true,
                  reasoning: {
                    supported: (levels | any(. != "none")),
                    can_disable: (levels | any(. == "none")),
                    levels: levels,
                    default_level: ((levels | map(select(. != "none")) | first) // "none")
                  }
                }
              } } ]
        | from_entries
        | . * ($over[0] // {})' <<<"$json" >"$tmp_info"

    mv "$tmp_list" "$MODELS_DIR/model_list.yaml"
    mv "$tmp_info" "$MODELS_DIR/models-info.json"
    echo "wrote $MODELS_DIR/model_list.yaml and $MODELS_DIR/models-info.json ($(jq 'length' "$MODELS_DIR/models-info.json") models: $(jq -r 'keys | join(", ")' "$MODELS_DIR/models-info.json"))"
    echo "if the stack is already up: docker compose up -d --force-recreate litellm caddy"
}

setup_team() {
    local issue="$1" master auth code models body
    [ -f "$MODELS_DIR/models-info.json" ] || die "$MODELS_DIR/models-info.json is missing; run: $0 models <models.yml>"
    need LITELLM_MASTER_KEY MONTHLY_BUDGET_USD
    master="$LITELLM_MASTER_KEY"
    auth=(-H "Authorization: Bearer $master" -H 'Content-Type: application/json')
    models="$(jq -c 'keys' "$MODELS_DIR/models-info.json")"

    code="$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$ADMIN/team/info?team_id=$TEAM" || true)"
    [ -n "$code" ] && [ "$code" != 000 ] || die "cannot reach $ADMIN; is the stack up?"
    case "$code" in
    200)
        local current
        current="$(curl -sf "${auth[@]}" "$ADMIN/team/info?team_id=$TEAM" | jq -c '.team_info.models // [] | sort')"
        if [ "$current" = "$(jq -c 'sort' <<<"$models")" ]; then
            echo "team $TEAM exists with the catalog's models (not modified)"
        else
            body="$(jq -nc --arg t "$TEAM" --argjson m "$models" '{team_id: $t, models: $m}')"
            curl -sf -o /dev/null "${auth[@]}" -d "$body" "$ADMIN/team/update"
            echo "team $TEAM exists; its models now match the catalog: $(jq -r 'join(", ")' <<<"$models")"
        fi
        ;;
    404)
        # team_member_permissions: what the service account key may call. By
        # default a team key may only read /key/info and /key/health.
        body="$(jq -nc --arg t "$TEAM" --argjson m "$models" --argjson p "$PERMISSIONS" --argjson b "$MONTHLY_BUDGET_USD" \
            '{team_id: $t, team_alias: $t, models: $m, max_budget: $b, budget_duration: "1mo", team_member_permissions: $p}')"
        curl -sf -o /dev/null "${auth[@]}" -d "$body" "$ADMIN/team/new"
        echo "team $TEAM created with budget \$$MONTHLY_BUDGET_USD per month and models $(jq -r 'join(", ")' <<<"$models")"
        ;;
    *)
        die "unexpected HTTP $code from $ADMIN/team/info; is the stack up?"
        ;;
    esac

    if [ -n "$issue" ]; then
        local alias answer key expires
        alias="$TEAM-runner-$(date -u +%Y%m%dT%H%M%SZ)"
        # The issuer key lasts 90 days; rotate it by running this again
        # before it expires and replacing the secret.
        body="$(jq -nc --arg t "$TEAM" --arg a "$alias" \
            '{team_id: $t, key_alias: $a, duration: "90d", metadata: {purpose: "flax agents runner: issues, blocks and reads per-run keys"}}')"
        answer="$(curl -sf "${auth[@]}" -d "$body" "$ADMIN/key/service-account/generate")"
        key="$(jq -r '.key // empty' <<<"$answer")"
        [ -n "$key" ] || die "the gateway issued no key: $answer"
        expires="$(jq -r '.expires // "unknown"' <<<"$answer")"
        echo "issued service account key $alias for team $TEAM, valid until $expires."
        echo "Put it in the workspace repository secret LLM_GATEWAY_ISSUER_KEY; it is not shown again:"
        echo "$key"
    fi
}

[ $# -ge 1 ] || usage
command="$1"
shift
case "$command" in
models)
    [ $# -eq 1 ] || usage
    load_env
    need PROVIDER_API_HOST
    write_models "$1"
    ;;
team)
    issue=""
    case "${1:-}" in
    "") ;;
    --issue-runner-key) issue=1 ;;
    *) usage ;;
    esac
    [ $# -le 1 ] || usage
    load_env
    setup_team "$issue"
    ;;
*)
    usage
    ;;
esac
