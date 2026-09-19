# Install the Jevbrain Codex plugin

The Jevbrain plugin runs the existing `task_route` MCP server over local stdio. It is distributed from this source checkout because the repository has no published package or remote marketplace yet.

The plugin selects a registered profile only. Codex or another host must still decide to delegate, launch the selected profile, enforce permissions, and verify the result.

## Requirements

- Bun 1.3.8 or newer
- A Codex CLI build with plugin support
- This source checkout with locked dependencies installed

## Stage and install the personal plugin

From the repository root, build and stage the plugin:

```bash
bun install --frozen-lockfile
bun run plugin:stage
```

The stage command preserves existing marketplace entries and writes only these Jevbrain locations:

- `~/.agents/plugins/marketplace.json`
- `~/plugins/jevbrain/`

It builds a self-contained `dist/server.js` before copying the plugin and gives the staged manifest a fresh Codex cachebuster. It refuses to replace a non-Jevbrain directory or a Jevbrain marketplace entry that points elsewhere.

Install the staged plugin:

```bash
codex plugin add jevbrain@personal
```

Start a new Codex task after installation so the MCP tool and companion skill load from the installed plugin.

## Configure registered profiles

The bundled registry contains nine role and effort templates for general, frontend, backend, debugging, review, and documentation work. All are marked unavailable. The bundled policy keeps provider access and egress off. A fresh installation therefore returns no entries from `task_route_options` and cannot select a profile until the host confirms real runtime availability.

`task_route_options` makes no provider call. It returns policy-allowed profiles that are both enabled and declared available, including model metadata and optional effort. It does not apply task-specific capability matching; `task_route` performs that check for the approved delegation.

Keep host-owned configuration outside the staged plugin, for example:

```text
~/.config/jevbrain/registry.json
~/.config/jevbrain/policy.json
```

Set `JEVBRAIN_REGISTRY` and `JEVBRAIN_POLICY` to those readable JSON file paths in the environment that launches Codex. Those values override the bundled files. Supply `TYPESAFE_API_KEY` through that process environment only when trusted policy explicitly enables both provider access and egress.

Every `plugin:stage` run regenerates the bundled disabled defaults. Store live host configuration at stable external paths instead of editing the staged copies.

The plugin does not bundle credentials, copy environment values into its cache, or log provider keys and configuration contents.

## Update a staged plugin

After changing the source checkout, run the same two commands:

```bash
bun run plugin:stage
codex plugin add jevbrain@personal
```

The stage command rebuilds the bundle, replaces the previous staged Jevbrain payload, preserves other marketplace entries, and writes a new cachebuster. Start a new Codex task after reinstalling.

## Build or validate without installing

Build the distributable payload:

```bash
bun run plugin:build
```

Validate the plugin manifest and skill from the repository root:

```bash
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/jevbrain
python3 /path/to/skill-creator/scripts/quick_validate.py plugins/jevbrain/skills/route-delegation
```

The repository test stages the plugin under a disposable marketplace root and calls its bundled MCP server with provider access disabled. It does not modify `~/.codex`, `~/.agents`, or `~/plugins`.

## Distribution limit

This is a local stdio plugin. The [Codex plugin documentation](https://developers.openai.com/plugins/build/plugins) requires a remote HTTPS MCP server for the public universal directory, so this bundle is not presented as a universal-directory integration.

A hosted Git marketplace would also need a checked-in marketplace catalog and a built, self-contained plugin payload. Publishing this repository alone would not make `codex plugin marketplace add owner/repo` work with the current source-staging layout.
