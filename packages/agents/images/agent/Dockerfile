# The run box image agent jobs use: the sandbox's (lbx) docker runtime
# contract (the agent user, the /home/agent and /data layout, the
# entrypoint, gosu) with Pi, an optional Pi provider plugin and the kit's Pi
# plugin (pi-mcp-mailbox), and nothing else. The sandbox's full image carries
# developer toolchains and several agents, and a fresh runner VM pulls the
# image on every job, so jobs use this one.
#
# Build context: a directory holding entrypoint.sh from the lbx release's
# tagged source (its commit is passed as BOX_COMMIT), and pi-mcp-mailbox.mjs,
# the Pi plugin bundled by `flax-agents bundle-pi-plugin`, whose sha256 is
# passed as PI_MCP_MAILBOX_SHA256. The Publish image workflow
# (workflows/publish-image.yml) builds it and pushes it as
# ghcr.io/<owner>/flax-agent; workspaces pin it by digest in box.yml.
FROM ubuntu:25.10

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive

# Exact versions only; flax-agents check refuses a range or a tag. To move to
# a new version, change it here, run the Publish image workflow and paste the
# values it prints into box.yml. The checksums are from
# https://nodejs.org/dist/v<NODE_VERSION>/SHASUMS256.txt.
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256_AMD64=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
ARG NODE_SHA256_ARM64=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5
ARG PI_VERSION=0.87.1
# The Pi provider plugin, an npm package, and its exact version. Both empty
# means no plugin: Pi's built-in provider talks to the runner's forwarder.
# A workspace whose provider needs a plugin builds with both set; the
# runner then loads /opt/pi-extensions/node_modules/<PI_PROVIDER_PACKAGE>
# with `--extension`.
ARG PI_PROVIDER_PACKAGE=
ARG PI_PROVIDER_VERSION=
# The version in images/agent/pi-mcp-mailbox/package.json, which the bundle
# must report as its CLIENT_VERSION.
ARG PI_MCP_MAILBOX_VERSION=0.3.0
ARG PI_MCP_MAILBOX_SHA256
ARG BOX_COMMIT

# The labels below record which entrypoint.sh and which plugin bundle this
# image holds, so they must name one exact commit and one exact file.
RUN [[ "$BOX_COMMIT" =~ ^[0-9a-f]{40}$ ]] \
    || { echo "BOX_COMMIT must be the full commit id of the lbx release (got: '$BOX_COMMIT')" >&2; exit 1; }
RUN [[ "$PI_MCP_MAILBOX_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    || { echo "PI_MCP_MAILBOX_SHA256 must be the sha256 of pi-mcp-mailbox.mjs (got: '$PI_MCP_MAILBOX_SHA256')" >&2; exit 1; }
RUN { [ -n "$PI_PROVIDER_PACKAGE" ] && [ -n "$PI_PROVIDER_VERSION" ]; } \
    || { [ -z "$PI_PROVIDER_PACKAGE" ] && [ -z "$PI_PROVIDER_VERSION" ]; } \
    || { echo "PI_PROVIDER_PACKAGE and PI_PROVIDER_VERSION must be set together or both empty (got: '$PI_PROVIDER_PACKAGE', '$PI_PROVIDER_VERSION')" >&2; exit 1; }

# Same mirror and IPv4 setting as the sandbox's full image: some Canonical
# CDN nodes are unreachable from the build hosts.
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4 \
    && sed -i 's|http://archive.ubuntu.com|http://ubuntu.osuosl.org|g' \
        /etc/apt/sources.list.d/ubuntu.sources

# ripgrep and fd back Pi's grep and find tools; without them on PATH Pi
# tries to download them, and the run box has no network. The
# entrypoint's user and group commands (usermod, groupmod, gpasswd, getent)
# come with the base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git jq ripgrep fd-find gosu \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd

# C.UTF-8 is built into glibc, so a UTF-8 locale needs no locales package.
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

RUN case "$(dpkg --print-architecture)" in \
        amd64) node_arch=x64; node_sha="$NODE_SHA256_AMD64" ;; \
        arm64) node_arch=arm64; node_sha="$NODE_SHA256_ARM64" ;; \
        *) echo "no Node checksum is pinned for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.gz" \
    && curl -fsSL --retry 3 -o "/tmp/$tarball" "https://nodejs.org/dist/v${NODE_VERSION}/$tarball" \
    && echo "$node_sha  /tmp/$tarball" | sha256sum -c - \
    && tar -xzf "/tmp/$tarball" -C /usr/local --strip-components=1 --no-same-owner \
        --exclude='*/include' --exclude='*/share/doc' \
    && rm "/tmp/$tarball" \
    && [ "$(node --version)" = "v${NODE_VERSION}" ]

# The agent user exactly as the sandbox's full image creates it (the
# entrypoint remaps its ids and name to the host user at start). Ubuntu
# 24.04 ships a user and group at 1000, which are removed first. sudo is not
# installed; /etc/sudoers.d exists only so the entrypoint's rewrite of
# /etc/sudoers.d/agent for a renamed user succeeds quietly, and run mode
# deletes that file again.
RUN existing_user=$(getent passwd 1000 | cut -d: -f1) \
    && [ -n "$existing_user" ] && userdel -r "$existing_user" 2>/dev/null || true \
    && existing_group=$(getent group 1000 | cut -d: -f1) \
    && [ -n "$existing_group" ] && groupdel "$existing_group" 2>/dev/null || true \
    && groupadd -g 1000 agent \
    && useradd -m -u 1000 -g agent -s /bin/bash agent \
    && install -d -m 0750 /etc/sudoers.d

# Pi globally as root; its npm-shrinkwrap.json fixes its dependencies. The
# provider plugin, when there is one, goes to a root-owned directory the job
# runner names with `--extension` (the extension paths in
# src/run-job/argv.ts), not into the agent profile, so the box user cannot
# change it and Pi's settings list no packages. The npm cache stays out of
# /home/agent, where a root-owned cache would break the agent user's npm.
ENV HOME=/home/agent
RUN NPM_CONFIG_CACHE=/root/.npm npm install -g --no-fund --no-audit \
        "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && if [ -n "$PI_PROVIDER_PACKAGE" ]; then \
        NPM_CONFIG_CACHE=/root/.npm npm install --no-fund --no-audit --ignore-scripts --legacy-peer-deps --prefix /opt/pi-extensions "${PI_PROVIDER_PACKAGE}@${PI_PROVIDER_VERSION}"; \
    fi \
    && rm -rf /root/.npm \
    && install -d -o agent -g agent /home/agent/.pi /home/agent/.pi/agent

# The Pi plugin: one bundled file that imports only Node's own modules, so
# it needs no node_modules. It sits in the same root-owned directory as the
# provider plugin, and the job runner names it with `--extension`
# (PI_MAILBOX_EXTENSION in src/run-job/argv.ts) before the provider, for
# every job. In a box run with lbx --no-network --socket-dir, it connects to
# the tools over /run/agent/tools.sock and runs a loopback shim on
# 127.0.0.1:18080 that passes the provider's connections to
# /run/agent/model.sock, the runner's model forwarder. It adds no file to
# the image.
COPY pi-mcp-mailbox.mjs /opt/pi-extensions/pi-mcp-mailbox.mjs
RUN chown root:root /opt/pi-extensions/pi-mcp-mailbox.mjs \
    && chmod 0644 /opt/pi-extensions/pi-mcp-mailbox.mjs

# Fails the build when Pi or a plugin is not the pinned version or not owned
# by root, when the Pi plugin is not the bundle the workflow made or
# does not load in Node, when Pi's search tools are missing, or when
# `pi --help` no longer lists a flag the job runner passes
# (src/run-job/argv.ts), so a Pi upgrade that drops one fails here instead
# of in a job.
RUN [ "$(pi --version)" = "$PI_VERSION" ] \
    && pi_help="$(PI_OFFLINE=1 pi --help)" \
    && for flag in --print --mode --offline --no-extensions --extension --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --session-dir --model --thinking --tools --session; do \
        grep -qE -- "^ +${flag}[ ,]" <<< "$pi_help" \
            || { echo "pi --help does not list $flag, which the job runner passes" >&2; exit 1; }; \
    done \
    && if [ -n "$PI_PROVIDER_PACKAGE" ]; then \
        [ "$(jq -r .version "/opt/pi-extensions/node_modules/${PI_PROVIDER_PACKAGE}/package.json")" = "$PI_PROVIDER_VERSION" ] \
        && [ "$(stat -c %U "/opt/pi-extensions/node_modules/${PI_PROVIDER_PACKAGE}")" = root ]; \
    fi \
    && [ "$(stat -c %U /opt/pi-extensions)" = root ] \
    && [ "$(stat -c %U:%G:%a /opt/pi-extensions/pi-mcp-mailbox.mjs)" = root:root:644 ] \
    && echo "$PI_MCP_MAILBOX_SHA256  /opt/pi-extensions/pi-mcp-mailbox.mjs" | sha256sum -c - \
    && node --input-type=module -e 'const m = await import(process.argv[1]); if (typeof m.default !== "function" || m.CLIENT_VERSION !== process.argv[2]) { console.error("pi-mcp-mailbox.mjs reports version " + m.CLIENT_VERSION + ", not " + process.argv[2]); process.exit(1); }' /opt/pi-extensions/pi-mcp-mailbox.mjs "$PI_MCP_MAILBOX_VERSION" \
    && rg --version && fd --version && git --version && jq --version && gosu --version

# Never ship a Pi credential file: if a build step that starts Pi writes an
# auth.json, a build environment that exports a provider key puts that key
# in it. This runs after the last step that starts Pi, and fails the build
# if a credential file would still ship. The caches Pi left in /tmp are
# owned by root and would stop the box user from writing its own there.
RUN rm -f /home/agent/.pi/agent/auth.json /root/.pi/agent/auth.json \
    && test ! -e /home/agent/.pi/agent/auth.json \
    && test ! -e /root/.pi/agent/auth.json \
    && chown -R agent:agent /home/agent/.pi \
    && find /tmp -mindepth 1 -delete

COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

ENV LBX_RUNTIME_TYPE=docker

RUN mkdir -p /data && chown agent:agent /data

LABEL org.opencontainers.image.title="flax-agent" \
      org.opencontainers.image.description="Run box image for flax agent jobs: Pi, an optional provider plugin and the pi-mcp-mailbox plugin on the sandbox's (lbx) entrypoint" \
      org.opencontainers.image.source="https://github.com/spice-labs-inc/flax" \
      io.flax.agent-image.box-commit="${BOX_COMMIT}" \
      io.flax.agent-image.node="${NODE_VERSION}" \
      io.flax.agent-image.pi="${PI_VERSION}" \
      io.flax.agent-image.provider-plugin="${PI_PROVIDER_PACKAGE}" \
      io.flax.agent-image.provider-plugin-version="${PI_PROVIDER_VERSION}" \
      io.flax.agent-image.mcp-mailbox-plugin="${PI_MCP_MAILBOX_VERSION}" \
      io.flax.agent-image.mcp-mailbox-plugin-sha256="${PI_MCP_MAILBOX_SHA256}"

# The entrypoint remaps the user and drops to it with gosu, so it starts as
# root, and lbx's `docker exec ... gosu` needs root too.
USER root
WORKDIR /data
ENTRYPOINT ["/entrypoint.sh"]
CMD ["sleep", "infinity"]
