# Skills Ecosystem Integration Contract

Status: decision research  
Investigated: 2026-07-30  
Upstream snapshot: `skills@1.5.21`, `vercel-labs/skills` commit
[`7cb7db64dc1201052dea305e508a2fc490f7e5e2`](https://github.com/vercel-labs/skills/commit/7cb7db64dc1201052dea305e508a2fc490f7e5e2)

## Verdict

Profile Workbench can safely reuse the official Skills CLI as a **pinned,
subprocess-based source acquisition adapter**, but it must not delegate Profile
inventory, provenance, updates, removal, recovery, or local `Link` semantics to
that CLI.

The safe integration is:

1. acquire remote Skills into an isolated staging directory with a pinned Skills
   CLI and explicit `CLAUDE_CONFIG_DIR`, `XDG_STATE_HOME`,
   `--agent claude-code`, `--global`, `--copy`, and `--yes`;
2. validate and preview the staged Skill;
3. let ccps apply the change to the selected Profile and record ccps-owned
   provenance;
4. let ccps implement local `Copy`, local `Link`, update, removal, and recovery.

This preserves the selected Profile as the only mutation target and prevents
upstream commands from silently changing the chosen install mode or bypassing
the Recovery Bin.

Integrated skills.sh discovery has one unresolved contract problem: the
documented JSON API requires a Vercel OIDC token, while the standalone Skills CLI
uses an undocumented unauthenticated endpoint. A local desktop CLI therefore has
no currently documented, credential-free search contract. Workbench must not
scrape website HTML. A product prototype or an upstream-supported client
contract is required before discovery can be a hard dependency.

## Source authority and version boundary

The findings use only:

- the [official skills.sh API reference](https://www.skills.sh/docs/api);
- the [official Skills CLI repository and README at the inspected
  commit](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/README.md);
- the [Agent Skills format specification](https://agentskills.io/specification);
- the current ccps source in this repository.

`skills@1.5.21` exposes command-line binaries but no documented package
`exports` or library API. Its supported reuse surface is therefore the CLI, not
imports from `src/*` or `dist/*` ([package
manifest](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/package.json#L1-L15)).
Workbench should pin a tested version behind a ccps adapter/stable wrapper; it
must not invoke a floating `npx skills`.

## Discovery and metadata

### Documented API

The documented API provides:

- paginated `all-time`, `trending`, and `hot` listings;
- fuzzy single-word and semantic multi-word search, with optional GitHub-owner
  filtering;
- a curated first-party collection;
- skill details containing a stable `id`, source, slug, install count, content
  hash, and complete file snapshot;
- per-provider security audits.

Listing/search objects contain `id`, `slug`, `name`, `source`, `installs`,
`sourceType`, `installUrl`, `url`, and optional `isDuplicate`. The search
response also reports `searchType`, count, and duration. The listing/search
shape does **not** include the Skill description; a consumer must fetch details
and parse `SKILL.md`, or stage the source, to display it. Detail `hash` and
`files` may be `null` when no snapshot exists. These fields and cache guidance
are defined by the [skills.sh API
reference](https://www.skills.sh/docs/api#skill-object).

Security responses contain one entry per provider with normalized
`pass`/`warn`/`fail`, a summary, `auditedAt`, optional
`NONE`/`LOW`/`MEDIUM`/`HIGH`/`CRITICAL` risk, and optional categories. A `404`
means no partner audit exists yet; audits may lag the first installation. The UI
must therefore distinguish `pass`, `warn`, `fail`, `not audited`, `unavailable`,
and `cached/stale` rather than treating missing data as safe
([audit contract](https://www.skills.sh/docs/api#get-api-v1-skills-audit-source-skill)).

All documented v1 endpoints require a Vercel OIDC bearer token. Local use
requires a directory linked to a Vercel project and a short-lived token; the
documented authenticated limit is 600 requests per minute per team/project
([authentication and rate
limits](https://www.skills.sh/docs/api#authentication)). That is not a suitable
mandatory setup for a local-first ccps user.

### What the current CLI actually uses

`skills find` does not use the documented v1 endpoint. It performs an
unauthenticated request to `https://skills.sh/api/search`, returns only name,
slug/id, source, and installs, and converts any HTTP or network failure to an
empty result
([`find.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/find.ts#L16-L115)).
The command has no JSON flag; only `skills list` has documented JSON output
([`cli.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/cli.ts#L105-L169)).

A live probe on 2026-07-30 confirmed:

- `GET /api/search?q=typescript&limit=1` returned `200` JSON without
  authentication;
- `GET /api/v1/skills/search?q=typescript&limit=1` returned `401` with
  `authentication_required` without Vercel OIDC.

`/api/search` is first-party implementation, but it is neither the documented
public API nor a stable machine contract. Calling it directly is not website
scraping, but it is still an unsupported dependency. Parsing the human,
ANSI-formatted output of `skills find` is also not a safe contract.

### Discovery decision

Use a provider boundary with three explicit states:

1. `SkillsShV1Provider` only when a supported OIDC credential source is
   deliberately configured;
2. an optional, clearly experimental adapter may test the current
   unauthenticated endpoint, with caching and graceful failure, but core Profile
   operations must not depend on it;
3. always retain source entry by GitHub/GitLab/git URL, direct download URL, or
   local path, plus a link that opens skills.sh in the browser.

Do not scrape skills.sh HTML pages or security pages. Do not present internal
`/api/search` or `add-skill.vercel.sh/audit` as a stable API.

## Source and installation contracts

The documented CLI accepts GitHub shorthand, GitHub URLs and direct tree paths,
GitLab URLs, generic git URLs, and local paths. Current source also accepts
direct `SKILL.md`/archive downloads, subject to documented download and
extraction limits
([source formats and
limits](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/README.md#L229-L297)).
`--skill`, `--agent`, `--global`, `--copy`, and `--yes` are documented CLI
options.

An Agent Skill is a directory containing `SKILL.md` with required YAML
frontmatter `name` and `description`; scripts, references, assets, and other
files are optional. Workbench should validate the strict format and surface
diagnostics before applying a staged source
([Agent Skills specification](https://agentskills.io/specification)).

The upstream installer sanitizes the destination name and rejects path
traversal. In copy mode it deletes/recreates the destination before copying. In
symlink mode it first copies into a canonical `.agents/skills` location, then
links the agent directory to that canonical copy; if link creation fails, it
silently falls back to a copy
([`installer.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/installer.ts#L265-L420)).
Those overwrite and fallback semantics do not satisfy Workbench's diff,
Recovery Bin, or explicit-Link requirements.

The CLI also fetches advisory security information before install, but that
fetch has a three-second timeout, returns `null` on failure, is rendered as
human output, and never blocks installation
([`telemetry.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/telemetry.ts#L94-L130),
[`add.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/add.ts#L1676-L1705)).
Workbench must not parse that table or infer safety from its absence.

### Safe acquisition invocation

For remote acquisition, invoke the pinned CLI with an argv array and no shell:

```text
env:
  CLAUDE_CONFIG_DIR=<isolated-staging>/claude-home
  XDG_STATE_HOME=<isolated-staging>/state
  DISABLE_TELEMETRY=1

argv:
  skills add <source>
    --skill <exact-skill>
    --global
    --agent claude-code
    --copy
    --yes
```

The resulting directory is staging input, not the final installation. ccps then:

1. scans only `<isolated-staging>/claude-home/skills`;
2. validates the format, paths, file count/size, and chosen Skill identity;
3. shows source, target, security state, and the file diff;
4. moves any overwritten target to the Recovery Bin;
5. applies the staged directory to the selected Profile;
6. records ccps-owned provenance.

This avoids parsing upstream terminal output and avoids direct destructive
mutation of the Profile.

## Exact selected-Profile targeting

ccps defines the selected Profile's Skill directory as
`<app-home>/profiles/<name>/claude-home/skills`
([`profile-template.ts`](../../src/core/profile-template.ts#L98-L118)) and
already launches Claude Code with that Profile's `claude-home` in
`CLAUDE_CONFIG_DIR`
([`launcher.ts`](../../src/core/launcher.ts#L110-L134)).

The inspected Skills CLI now resolves Claude Code's global Skill path from
`CLAUDE_CONFIG_DIR`, falling back to the real `~/.claude` only when the variable
is absent
([`agents.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/agents.ts#L7-L13),
[`agents.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/agents.ts#L136-L143)).
Therefore `--global --agent claude-code --copy` with the selected
`CLAUDE_CONFIG_DIR` writes to `<selected-claude-home>/skills`, not the real
`~/.claude/skills`.

The global upstream lock defaults to `~/.agents/.skill-lock.json`, but honors
`XDG_STATE_HOME`
([`skill-lock.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/skill-lock.ts#L62-L73)).
An acquisition subprocess must set an isolated `XDG_STATE_HOME` as shown above.

A local macOS probe with `skills@1.5.21` verified that:

```text
CLAUDE_CONFIG_DIR=<temp>/profile/claude-home
XDG_STATE_HOME=<temp>/profile/state
skills add vercel-labs/skills@find-skills \
  --global --agent claude-code --copy --yes
```

created the staged `profile/claude-home/skills/find-skills` target and the
isolated v3 lock. A local-path copy similarly landed in the staged Profile. No
command targeted the real `~/.claude`.

For production, staging is stronger than relying on this target contract alone:
even an upstream regression cannot overwrite a real Profile before ccps
validation and apply.

## Inventory and provenance

Workbench should inventory installed Skills by scanning the selected Profile's
known `skillsPath` and parsing `SKILL.md` itself. This is deterministic, offline,
and cannot mix other user-level agents into the selected Profile.

Although `skills list --json` returns name, path, scope, agents, source,
sourceUrl, and sourceType
([`list.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/list.ts#L97-L128)),
the current implementation intentionally scans existing directories for agents
outside an `--agent` filter to find orphaned installations
([`installer.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/installer.ts#L1124-L1166)).
A live `list -g -a claude-code --json` probe consequently included Skills from
other real user-level agents. It is not a selected-Profile inventory contract.

The upstream v3 global lock records source, source type, source URL, ref, skill
path, folder hash, timestamps, and optional plugin name, but not target Profile,
agent, install mode, or local link target
([`skill-lock.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/skill-lock.ts#L8-L60)).
Older lock versions are treated as empty rather than migrated
([`skill-lock.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/skill-lock.ts#L75-L103)).
A local-path global copy did not produce an upstream lock entry in the inspected
flow; global lock insertion is gated on a normalized remote source
([`add.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/add.ts#L1825-L1866)).
The upstream lock cannot be the Workbench source of truth.

ccps needs a Profile-owned manifest with, at minimum:

- Skill name and selected Profile identity;
- source kind and original source;
- source ref and source-relative Skill path when applicable;
- `copy` or `link`;
- installed and updated timestamps;
- upstream/content hash;
- link target and current link-health state when applicable;
- cached audit records with provider and `auditedAt`.

The exact manifest file and schema should be fixed by architecture design, not
borrowed as an undocumented dependency on the upstream lock.

## Update and removal

Do not invoke `skills update` for a selected Profile. The current global update
re-runs `add <source> -g -y` without preserving `--agent` or `--copy`
([`update.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/update.ts#L448-L490)).
That can select other detected/universal agents and can change a copied Profile
Skill into an upstream canonical-store link. Local-path Skills are not
automatically checkable by the update flow.

For a copied remote Skill, ccps should re-acquire the exact recorded source into
staging, compare hashes/files, show the diff, and apply through the same
Recovery-Bin transaction as installation. For a copied local Skill, “Update”
means an explicit re-copy from the recorded source. For a linked local Skill,
upstream changes are already live; Workbench should report link health and open
the source rather than pretend to perform an update.

Do not invoke `skills remove` for Workbench removal. It uses recursive deletion
on agent and canonical paths and removes its lock entry
([`remove.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/remove.ts#L216-L295)).
That bypasses the agreed Recovery Bin. ccps must move a copied Skill to recovery
and remove only the link entry for a linked Skill; it must never delete the
linked source.

## Copy and Link implications

| Mode   | Required Workbench semantics                                                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Copy` | Default. Copy the complete validated Skill directory into the selected Profile. It becomes independent and portable with the Profile. Updates are explicit re-acquisitions/re-copies and must show a diff.                                                                                                                                                          |
| `Link` | Explicitly visible local-source option. Link the selected Profile entry directly to the user's source directory, record the absolute source, and show healthy/broken status. Source edits are immediately live. Moving/deleting the source breaks the Skill. Removing from the Profile unlinks only the entry. Profile backup does not back up the external source. |

The upstream CLI's “Symlink” is not the required local `Link`: it copies the
source to its own canonical store and links the agent directory to that copy.
For a single target directory, the CLI changes the selected mode to `copy`
anyway
([`add.ts`](https://github.com/vercel-labs/skills/blob/7cb7db64dc1201052dea305e508a2fc490f7e5e2/src/add.ts#L756-L785)).
It also falls back to copying after link failure. Workbench must implement
`Link` itself and fail visibly with a `Copy` suggestion when link creation is
unavailable.

On macOS the intended primitive is a directory symbolic link. On Windows the
product label should remain `Link`, but the exact primitive and privilege
behavior (symbolic link versus directory junction), cross-volume behavior, and
backup/copy/rename handling require a hosted Windows prototype before claiming
parity.

## Offline contract

The supported offline experience is:

- Profile inventory, search within installed files, preview, validation, edit,
  link-health checks, removal/recovery, and launch remain fully available from
  local state;
- local `Copy` and `Link` remain available;
- cached catalog/detail/audit data may be shown with its fetch timestamp and a
  stale marker;
- uncached skills.sh discovery and security are unavailable, not “no results”
  and not “safe”;
- remote install/update is unavailable with a clear retry message;
- a linked Skill continues to work while its source exists;
- copied local/remote Skills continue to work without their origin.

This is stricter than `skills find`, which collapses network and HTTP failures
to an empty result. Workbench must preserve the distinction between “zero
matches” and “catalog unavailable.”

## Prototype-required facts

The following are not settled contracts and should become explicit follow-up
decisions/prototypes:

1. **Standalone discovery authentication:** obtain an upstream-supported
   credential-free/client-auth contract, accept a user-linked Vercel OIDC flow,
   or consciously ship the undocumented search endpoint as experimental with a
   fallback. Website scraping is not an option.
2. **Pinned CLI distribution:** verify the repository-compliant packaging and
   stable wrapper on clean macOS and hosted Windows, including offline error
   classification and exit-code behavior.
3. **Remote selection identity:** verify API `id`/slug to CLI `--skill`
   translation across GitHub, well-known, direct-tree, and duplicate-name
   sources. Do not infer it by parsing human output.
4. **Windows Link:** verify symbolic-link/junction creation, privilege failure,
   broken-link detection, removal, Profile copy/rename, and backup behavior.
5. **Manifest transaction:** fix the ccps provenance schema and prove that
   install/update/recovery changes the Skill directory and manifest atomically.

## Decision for the Wayfinder map

Adopt a **ccps-owned Profile Skill manager with a pinned upstream acquisition
adapter**. The official Skills CLI and Agent Skills spec are inputs to that
manager, not its state model. Integrated discovery remains in scope, but its
standalone authentication/endpoint choice must be resolved before the feature
can be called production-stable.
