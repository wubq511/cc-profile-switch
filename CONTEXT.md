# CC-Profile-Switch

CC-Profile-Switch provides isolated Claude Code user configuration environments and a single place to work with them.

## Language

**Profile**:
A named, isolated Claude Code user configuration environment selected for a launch.
_Avoid_: Account, workspace, runtime

**Profile Resource**:
A configuration or capability owned by one Profile, such as Memory, Skills, Agents, MCP configuration, Settings, or Plugins.
_Avoid_: File, asset, component

**Managed Profile Resource**:
A Profile Resource that CC-Profile-Switch may inspect, create, update, and remove.
_Avoid_: Editable file

**Claude-managed Profile Resource**:
A Profile Resource whose lifecycle belongs to Claude Code and which CC-Profile-Switch may change only through Claude Code's supported mechanisms.
_Avoid_: Managed Profile Resource

**Profile Workbench**:
The interactive workspace through which a user explores and manages Profiles and their Profile Resources.
_Avoid_: Dashboard, control center, GUI

**User Memory**:
Profile-scoped instructions intentionally authored by the user for Claude Code.
_Avoid_: System prompt, global memory

**Auto Memory**:
Profile-scoped knowledge maintained by Claude Code across sessions.
_Avoid_: User Memory, session history

**Local Skill Source**:
A Skill directory on the local filesystem that can be added to a Profile.
_Avoid_: Installed Skill

**Copied Skill**:
An independent Skill snapshot owned by a Profile after it is copied from a Local Skill Source.
_Avoid_: Linked Skill

**Linked Skill**:
A Profile Skill that continues to use a Local Skill Source as its source of truth, so source changes appear in the Profile.
_Avoid_: Copied Skill

**Skill Provenance Record**:
The ccps-owned record of a Profile Skill's source, copy or link mode, content fingerprint, and cached audit state, kept per Profile outside `claude-home` and never delegated to the upstream Skills lock file.
_Avoid_: Lock file, Skills CLI state

**Profile Backup**:
A durable point-in-time copy of a Profile intentionally retained for later restoration.
_Avoid_: Recovery Item

**Recovery Item**:
A snapshot of a removed Profile (explicit no-backup removal) or removed Managed Profile Resource, plus the coordinates needed to restore it, retained temporarily so the user can undo its removal. The snapshot is either a file tree (Profile, Skill directory, Memory file) or a fragment (an MCP server entry, a Settings field) with its location.
_Avoid_: Profile Backup, system trash

**Recovery Bin**:
The collection of unexpired Recovery Items managed by CC-Profile-Switch.
_Avoid_: Backups, system trash
