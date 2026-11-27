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

1. In the dashboard, open **Settings → API Keys** and create a key. Choose **Read only** if the agent should only look, or **Full access** to let it change things. Tick **Only some scenes** and pick them to keep the agent to those scenes: it then can't see or change anything else, including your other scenes, media, events and the Design Studio.
2. Add a remote MCP server to your agent, with the URL `https://api.virvi.io/mcp` (on a self-hosted install, your server's address followed by `/mcp`) and the header `Authorization: Bearer <your key>`.

The key acts as your account: the agent can do exactly what you can, through the same checks as the dashboard and the REST API, and its changes show in a scene's activity log as **API**. A read-only key gets only the read tools. **Activity** next to the key in Settings lists what agents did with it: each tool, the scene it named, and whether it worked (the last 100 calls, kept 90 days). Delete the key in Settings to cut the agent off; its activity goes with it.

The tools are the same ones the dashboard's [Assistant](/docs/dashboard/assistant/) uses, so they behave the same way:

| Area | Read | Change (full-access keys) |
|------|------|---------------------------|
| Scenes | `list_scenes`, `get_scene`, `get_scene_publishing`, `get_scene_performance`, `get_scene_activity`, `get_scene_errors` | `create_scene`, `update_scene` |
| Presets and schedules | `get_preset_schedules` | `create_preset`, `rename_preset`, `activate_preset`, `create_preset_schedule`, `update_preset_schedule` |
| Items and placements | `list_scene_library`, `list_scene_streams` | `create_element`, `update_element`, `set_element_live`, `add_instance`, `update_instance`, `remove_instance`, `add_to_library`, `rename_library_item` |
| Events and shows | `list_events`, `get_event`, `list_showings`, `list_shows`, `get_show` | `create_event`, `update_event`, `link_event_scene`, `create_showing`, `start_show`, `attach_to_show`, `close_show` |
| Media and Design Studio | `list_media`, `list_designs`, `get_design`, `get_studio_usage`, `get_finalize_quote` | `create_design` |
| Rewards | `list_scene_raffles`, `get_beat` | `create_beat_draft`, `create_giveaway` |
| Analytics and account | `list_analytics_locations`, `get_analytics_summary`, `get_plan`, `list_orgs`, `list_scene_collaborators`, `get_deploy_status`, `explain_deploy_failure`, `search_help` | |

What costs money or shows something publicly isn't offered through MCP: sending Studio prompts, finalizing, paying for a BEAT, creating or changing raffles, redeploying, and inviting collaborators. Do those in the dashboard, where you confirm them. `remove_instance` can't be undone, so the agent is told to check with you first. Other people's emails and wallets are hidden in results, as they are for the Assistant.

The server also offers:

- **Resources:** each of your scenes as `virvi://scene/<id>`, its current presets, elements and placements, which an agent can attach as context, and `virvi://guide`, a short note on how Virvi's scenes work.
- **Prompts:** starter workflows your agent may show in its prompt menu: **Set up an event** (create it, link a scene and schedule a preset), **Build a gallery from my media** and **Weekly report for a scene**.

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
