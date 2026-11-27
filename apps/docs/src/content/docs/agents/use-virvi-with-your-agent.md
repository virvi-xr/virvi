---
title: Use Virvi with your AI agent
description: Point Claude Code, Cursor, Codex or any coding agent at these docs to set up your own Virvi server or build advanced features on Virvi.
sidebar:
  order: 1
---

These docs are written so an AI agent can read them as well as you. Give your agent one link and it can find the rest.

## The links to give your agent

| What | URL |
|---|---|
| Index of every page, with Markdown links | `https://virvi.io/docs/llms.txt` |
| All the docs in one file | `https://virvi.io/docs/llms-full.txt` |
| Any single page as Markdown | add `.md` to its path, e.g. `https://virvi.io/docs/self-hosting/overview.md` |
| The MCP server, for agents that use tools | `https://api.virvi.io/mcp` (see [Connect with MCP](#connect-with-mcp)) |

The site also answers `https://virvi.io/llms.txt`, the conventional place agents look first.

If your agent can't browse, download `llms-full.txt` and add it to the conversation or your project.

## Connect with MCP

Agents that support the Model Context Protocol (MCP), such as Claude, Cursor and others, can connect to Virvi directly and work on your scenes with tools, without writing requests themselves.

1. In the dashboard, open **Settings → API Keys** and create a key. Choose **Read only** if the agent should only look, or **Full access** to let it change things.
2. Add a remote MCP server to your agent, with the URL `https://api.virvi.io/mcp` (on a self-hosted install, your server's address followed by `/mcp`) and the header `Authorization: Bearer <your key>`.

The key acts as your account: the agent can do exactly what you can, through the same checks as the dashboard and the REST API, and its changes show in a scene's activity log as **API**. A read-only key gets only the read tools. Delete the key in Settings to cut the agent off.

| Tool | What it does |
|------|--------------|
| `list_scenes` | Your scenes and those shared with you |
| `get_scene` | A scene's presets, items and copies, with positions in metres |
| `get_scene_performance` | How the scene compares with Decentraland's limits, and suggested fixes |
| `get_scene_activity` | Who changed what, and when (hosts and co-hosts) |
| `list_events` | Your events |
| `list_media` | Your media library, with URLs to use in items |
| `list_analytics_locations`, `get_analytics_summary` | Visitor totals for a place, under the dashboard's privacy rules |
| `set_live_preset` | Switch which preset is live (full-access keys) |
| `update_item` | Rename, show or hide an item, or change some of its properties (full-access keys) |
| `place_copy`, `move_copy` | Place or move a copy of an item (full-access keys) |
| `remove_copy` | Remove a copy; the agent is told to check with you first (full-access keys) |

Signing in with your Virvi account through the agent, instead of a key, comes later, along with more tools (events, schedules, uploads, the Design Studio).

## Prompts that work

**Run your own server**

> Read https://virvi.io/docs/llms.txt, then the Self-Hosting pages. Set up Virvi on this machine with Docker Compose. Ask me before choosing a domain, and list every environment variable you set and why.

**Add Virvi to a Decentraland scene**

> Read https://virvi.io/docs/sdk/decentraland/install.md and install Virvi in this SDK7 project. Keep my existing code; show me the diff before writing.

**Build a custom feature**

> Read the SDK and Custom Features pages from https://virvi.io/docs/llms.txt. I want a scoreboard that every visitor sees update live in my Decentraland scene. Plan it with `@virvixr/dcl` and Virvi's multiplayer messages before coding, and only use functions the docs list.

**Use the API from a script**

> Read https://virvi.io/docs/api/authentication.md and https://virvi.io/docs/api/rest-reference.md. Write a script that lists my scenes and switches one to its "Evening" preset, using an API key from an environment variable.

## Tips

- **Tell the agent which Virvi it's talking to.** Hosted (`https://virvi.io`) or your own server's URL. Self-hosted installs serve the same docs at `<your server>/docs`, matching your version.
- **Keep keys out of prompts.** Create an API key in the dashboard and put it in an environment variable; tell the agent the variable's name, not the key.
- **Ask for a plan first** on anything that deploys or changes a live scene. Virvi applies changes to visitors in real time.
- **Versions matter.** These docs match `@virvixr/dcl` 2.23.0, the only SDK package on npm. The API is described by each server at `/api/docs/json`. If something in the docs doesn't match what your agent sees, check the package version and tell us with *Report a bug* in the dashboard.
