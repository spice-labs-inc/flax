#!/usr/bin/env bash
# Publishes the workspace's packages as prebuilt git tags of this repository.
#
# For each @flax/* package it runs pnpm pack (so the package's files list
# decides what ships and workspace links become versions), unpacks the
# tarball, sets the version, drops devDependencies and scripts, points every
# @flax/* dependency at the sibling tag of the same version, and records the
# result as a commit with no parent, tagged <package>-v<version> (for
# example core-v0.1.0). A consumer then depends on
#   "@flax/core": "git+https://github.com/<owner>/flax.git#core-v0.1.0"
# and gets the built package without a build step of its own.
#
# Usage: scripts/publish-packages.sh <version> [--repo-url <url>] [--push <remote>]
#   <version>    MAJOR.MINOR.PATCH, the version every package gets.
#   --repo-url   The git URL consumers use; default https://github.com/spice-labs-inc/flax.git,
#                or https://github.com/$GITHUB_REPOSITORY.git when that variable is set.
#   --push       Push the new tags to this remote. Without it the tags are created locally only.
# Run `pnpm install` and `pnpm -r build` first. A tag that already exists is an error:
# a version is published once.
set -euo pipefail

version="${1:?usage: $0 <version> [--repo-url <url>] [--push <remote>]}"
shift
repo_url="https://github.com/${GITHUB_REPOSITORY:-spice-labs-inc/flax}.git"
push_remote=""
while [ $# -gt 0 ]; do
    case "$1" in
        --repo-url) repo_url="$2"; shift 2 ;;
        --push) push_remote="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done
if ! printf '%s' "$version" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
    echo "version must be MAJOR.MINOR.PATCH, got: $version" >&2
    exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
source_commit="$(git rev-parse HEAD)"
work="$(mktemp -d "${TMPDIR:-/tmp}/flax-publish.XXXXXX")"
trap 'rm -rf "$work"' EXIT

packages=()
for manifest in packages/*/package.json; do
    name="$(jq -r '.name // empty' "$manifest")"
    case "$name" in @flax/*) ;; *) continue ;; esac
    [ "$(jq -r '.private // false' "$manifest")" = "true" ] && continue
    packages+=("${name#@flax/}")
done
[ ${#packages[@]} -gt 0 ] || { echo "no @flax/* packages under packages/" >&2; exit 1; }

for short in "${packages[@]}"; do
    git rev-parse -q --verify "refs/tags/$short-v$version" >/dev/null && {
        echo "tag $short-v$version already exists; a version is published once" >&2
        exit 1
    }
done

tags=()
for short in "${packages[@]}"; do
    dir="packages/$short"
    out="$work/$short"
    mkdir -p "$out/tgz"
    if ! pnpm -C "$dir" pack --pack-destination "$out/tgz" > "$out/pack.log" 2>&1; then
        cat "$out/pack.log" >&2
        echo "pnpm pack failed for @flax/$short (run pnpm install and pnpm -r build first)" >&2
        exit 1
    fi
    tarball="$(ls "$out/tgz"/*.tgz)"
    mkdir -p "$out/pkg"
    tar -xzf "$tarball" -C "$out/pkg" --strip-components=1
    jq --arg v "$version" --arg repo "$repo_url" '
        .version = $v
        | del(.devDependencies, .scripts, .packageManager)
        | (if .dependencies then .dependencies |= with_entries(
              if (.key | startswith("@flax/")) then .value = "git+" + $repo + "#" + (.key | ltrimstr("@flax/")) + "-v" + $v else . end)
           else . end)
        | (if .peerDependencies then .peerDependencies |= with_entries(
              if (.key | startswith("@flax/")) then .value = "git+" + $repo + "#" + (.key | ltrimstr("@flax/")) + "-v" + $v else . end)
           else . end)
    ' "$out/pkg/package.json" > "$out/package.json.new"
    mv "$out/package.json.new" "$out/pkg/package.json"

    export GIT_INDEX_FILE="$out/index"
    git --work-tree="$out/pkg" add -A -f .
    tree="$(git write-tree)"
    unset GIT_INDEX_FILE
    commit="$(git commit-tree "$tree" -m "@flax/$short $version" -m "Built from $source_commit")"
    git tag "$short-v$version" "$commit"
    tags+=("$short-v$version")
    files="$(git ls-tree -r --name-only "$commit" | wc -l)"
    echo "$short-v$version  $commit  $files files"
done

if [ -n "$push_remote" ]; then
    refs=()
    for t in "${tags[@]}"; do refs+=("refs/tags/$t:refs/tags/$t"); done
    git push "$push_remote" "${refs[@]}"
fi

echo
echo "Depend on these with:"
for short in "${packages[@]}"; do
    echo "  \"@flax/$short\": \"git+$repo_url#$short-v$version\""
done
