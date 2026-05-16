![Lauren](lauren.jpg)

# Lauren

Lauren is a [Ralph](https://github.com/snarktank/ralph)-inspired loop: it drains a TODO list, asking an agent to implement each item in a fresh context.

The difference is the list stays editable while the loop runs. New ideas can append, merge with, or replace pending work as you think of them.

## How it works

Trigger `/lauren` from Claude Code to describe what you want next. The Lauren daemon, started with `lauren vibe`, asks an agent to integrate your request into the project TODO list. It decides whether to append, merge, refine, or replace pending tasks.

Once running, Lauren keeps looping through the TODO list and, for each task:

- create an isolated git worktree;
- ask the configured agent to implement the task (defaults to Claude);
- ask the configured agent to review the result (defaults to Codex);
- ask the configured agent to fix issues from the review (defaults to Claude);
- merge the work automatically, or open a PR depending on your configuration.

Each pipeline phase (and the merger conflict-resolver and brain placement
calls) can be routed to either `claude` or `codex` independently — see
the `agents` block in [Configuration](#configuration).

## Requirements

- `claude` on `$PATH`, authenticated and usable from the terminal
- `codex` on `$PATH`, authenticated and usable from the terminal
- A clean Git working tree before running `lauren vibe`

Lauren runs against the current Git repository (or a parent folder containing
one or more git sub-repositories).
Run `lauren` from inside the project you want to change, not from the lauren install directory.

## Install

From source:

```sh
git clone https://github.com/ofux/lauren.git
cd lauren
npm ci
npm run build
npm link
```

This exposes one command:

- `lauren`: planning, AI-managed queue operations, and queue execution

Check the install:

```sh
lauren --help
lauren vibe --help
```

## Quick Start

### Optional: add some specs (recommended if you're starting a new project)

```sh
lauren spec
```

This will help you create a solid (but simple) initial spec for your project.

### Init

In the repository you want Lauren to modify, initialize Lauren to install required SKILLs:

```sh
lauren init
```

### Start

Start the daemon in another terminal:

```sh
lauren vibe
```

### Work

Then, in claude, just type `/lauren` and describe what you want.

If you've been discussing with claude about something and realize afterwards that you want to turn this into a lauren plan, just say so (e.g. "Add what we've just discussed about to lauren").

Behind the scenes, they will both use the Lauren SKILL to create a proper plan (in the format expected by Lauren) and register it to the todo list.

**Important: dirty state might prevent Lauren from being able to auto-merge on your main branch. I strongly recommend you to use git worktrees if you want to work in parallel of Lauren.**

BTW, you can see the current state of the TODO-list with:

```sh
lauren
```

This will open a simple TUI showing what's in the queue, and will allow you to cancel some tasks.

## Configuration

Settings live in `.lauren/config.json` in your project. All fields are optional;
missing fields fall back to the defaults shown below:

```json
{
  "version": 1,
  "dev_branch": "main",
  "merge_mode": "auto",
  "agents": {
    "implement": "claude",
    "review": "codex",
    "fix": "claude",
    "merger": "claude",
    "brain": "claude"
  }
}
```

Each `agents` role accepts `"claude"` or `"codex"` and can be configured
independently. The three pipeline phases (`implement`, `review`, `fix`) cover
the per-plan run; `merger` is invoked only when an auto-merge hits conflicts;
`brain` runs the JSON placement / reorganize decisions over the queue.
