# Mellivora Malatang

[中文](README.md) · **English**

A desktop agent chat client that runs on your own machine.

It isn't built for "chatting with a model". It's built to **put an agent inside the daily work of a real project** — reading code, querying databases, logging into servers, proposing plans, reaching conclusions. You hand it a project together with its code, databases, servers and knowledge base, then delegate work through conversation.

![New session](docs/images/screenshot-new-session.png)

Sessions are organized by project on the left. Starting a new task means picking the project, picking a model, deciding how much authority the agent gets this time — then saying what you need.

![In a session](docs/images/screenshot-conversation.png)

Inside a session the agent's analysis, code and plans flow in one stream; the footer keeps the current project, branch and usage in view.

## The problem it addresses

Debugging a production issue, reconciling data, making sense of logic nobody can explain — each of these means bouncing between an IDE, a database client, a terminal and a docs site. What actually eats the time isn't any single step; it's carrying context between the tools.

Mellivora pulls them into one session. The agent holds the project's code and its running environments at the same time, so it can walk the whole chain itself — read the code, query the data, confirm on the machine, state the conclusion — instead of being hand-fed at every step.

## What it does

**Work is organized by project**
A project is a complete working environment: code sources (local directories or remote repositories), per-environment connections to databases / Redis / message queues / config centers / Elasticsearch, servers it can log into, and any knowledge bases you connect. One project can run many sessions in parallel, each independent.

**Environments are distinct**
Connections are configured separately for dev / test / prod. The agent knows which environment it is operating on, and production is read-only by default.

**It can act, but every step is yours to allow**
The agent can read and write files, run commands, query databases and log into servers. Anything with real consequences stops and waits for your approval; you can allow it once, allow it for the session, or allow it permanently for a project. Dangerous operations are never remembered as "don't ask again".

**Plan first, then act**
For complex tasks the agent proposes an implementation plan first. You can annotate it section by section, send it back for revision, and only after you approve does execution begin. When it's done it can produce a walkthrough of what changed and why.

**Results aren't only text**
Query results, tables, charts, plans and walkthroughs appear as cards and panels — you can keep asking about them, export them, or reference them directly in the next turn. Side panels for code review, the data browser, artifacts and run logs work alongside the conversation.

**The composer is the command line**
In the input box, `@` references files, `/` runs commands, `$` loads skills, `#` links related conversations. Images can be pasted or dropped in.

**Bring your own model**
Works with Anthropic and any OpenAI-compatible endpoint. You supply the key, and each session picks its own model.

**Also**
English and Chinese interface, dark / light / high-contrast themes, replayable run logs.

## Where your data lives

Project configuration, session history and credentials all stay in the application data directory on your machine. Nothing is uploaded anywhere. Apart from the model providers and data sources you configure yourself, the app talks to nothing external. Deleting a project only removes the app's own data — your local code is untouched.

## Running locally

```bash
npm install
npm run dev
```

## License

MIT
