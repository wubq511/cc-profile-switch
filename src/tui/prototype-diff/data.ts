// PROTOTYPE (throwaway) — mock data for the diff-presentation prototype.
// Ticket: "Prototype rich diffs and cross-Profile comparison" (issue #44).
// Diff resources confirmed by issue #28: User Memory, Agents, Settings
// (redacted: key names only, never values), MCP (server inventory only),
// Copied Skills vs source (hash diff), launch configuration (profile.json).
// Domain language follows CONTEXT.md. No persistence, no real filesystem access.

export interface McpServer {
  name: string;
  transport: 'stdio' | 'http';
  status: 'connected' | 'failed' | 'unchecked';
}

export interface SkillFile {
  path: string;
  hash: string; // short fingerprint stand-in for sha256
}

export interface CopiedSkill {
  name: string;
  source: string; // local source directory the copy was taken from
  profileFiles: SkillFile[];
  sourceFiles: SkillFile[]; // live source state today
}

export interface DiffProfile {
  name: string;
  userMemory: string[]; // claude-home/CLAUDE.md lines
  agents: Record<string, string[]>; // agents/<name>.md lines
  settings: Record<string, string>; // settings.json flattened; values NEVER rendered
  mcp: McpServer[]; // .claude.json user-scope inventory; config values NEVER rendered
  skills: CopiedSkill[];
  launch: Record<string, string>; // profile.json launch configuration (not secret)
}

export const coding: DiffProfile = {
  name: 'coding',
  userMemory: [
    '# User Memory',
    '',
    '- Prefer pnpm over npm for all Node work.',
    '- Run `npm run check` before every commit.',
    '- Never commit secrets or tokens.',
    '- Use strict TypeScript; no `any` without a comment.',
    '- Keep functions under 40 lines.',
  ],
  agents: {
    'reviewer.md': [
      '---',
      'name: reviewer',
      'description: Reviews diffs for correctness and style',
      'model: sonnet',
      '---',
      '',
      'You review code changes. Be terse. Cite file:line.',
    ],
    'tester.md': [
      '---',
      'name: tester',
      'description: Writes Vitest coverage for changed code',
      '---',
      '',
      'You write tests. Follow existing test conventions.',
    ],
  },
  settings: {
    model: 'claude-sonnet-4-5',
    'env.ANTHROPIC_API_KEY': 'sk-ant-REDACTED-a',
    'env.ANTHROPIC_BASE_URL': 'https://relay-a.example.com',
    'env.CLAUDE_CODE_ATTRIBUTION_HEADER': '0',
    autoMemoryDirectory: 'memory/auto',
    'permissions.allow': 'Bash(npm run *)',
  },
  mcp: [
    { name: 'context7', transport: 'http', status: 'connected' },
    { name: 'codegraph', transport: 'stdio', status: 'connected' },
    { name: 'playwright', transport: 'stdio', status: 'failed' },
  ],
  skills: [
    {
      name: 'grilling',
      source: '~/src/prompts/skills/grilling',
      profileFiles: [
        { path: 'SKILL.md', hash: 'a1b2c3' },
        { path: 'questions.md', hash: 'd4e5f6' },
      ],
      sourceFiles: [
        { path: 'SKILL.md', hash: 'a1b2c3' },
        { path: 'questions.md', hash: 'ff0099' }, // source moved on
        { path: 'examples.md', hash: '0a0a0a' }, // new at source
      ],
    },
    {
      name: 'commit',
      source: '~/src/prompts/skills/commit',
      profileFiles: [{ path: 'SKILL.md', hash: '77aa11' }],
      sourceFiles: [{ path: 'SKILL.md', hash: '77aa11' }],
    },
  ],
  launch: {
    mcpMode: 'none',
    skipPermissions: 'false',
    claudeArgs: '--model claude-sonnet-4-5',
    attributionHeader: '0',
  },
};

export const study: DiffProfile = {
  name: 'study',
  userMemory: [
    '# User Memory',
    '',
    '- Prefer pnpm over npm for all Node work.',
    '- Explain concepts with spaced-repetition prompts.', // changed line
    '- Never commit secrets or tokens.',
    '- Use strict TypeScript; no `any` without a comment.',
    '- Summarize every session into Anki cards.', // added line
  ],
  agents: {
    'reviewer.md': [
      '---',
      'name: reviewer',
      'description: Reviews diffs for correctness and style',
      'model: opus', // changed frontmatter value
      '---',
      '',
      'You review code changes. Be terse. Cite file:line.',
      'Flag anything that weakens recall.', // added body line
    ],
    'tutor.md': [
      // new agent, absent in coding
      '---',
      'name: tutor',
      'description: Socratic tutor for study sessions',
      '---',
      '',
      'Ask, do not tell.',
    ],
  },
  settings: {
    model: 'claude-opus-4-1', // differs
    'env.ANTHROPIC_API_KEY': 'sk-ant-REDACTED-b', // differs — never show
    // no ANTHROPIC_BASE_URL — absent
    'env.CLAUDE_CODE_ATTRIBUTION_HEADER': '0',
    autoMemoryDirectory: 'memory/auto',
    'permissions.allow': 'Bash(npm run *)',
    'permissions.deny': 'Bash(rm -rf *)', // extra key
  },
  mcp: [
    { name: 'context7', transport: 'http', status: 'connected' },
    { name: 'obsidian-notes', transport: 'stdio', status: 'connected' }, // only here
  ],
  skills: [
    {
      name: 'grilling',
      source: '~/src/prompts/skills/grilling',
      profileFiles: [
        { path: 'SKILL.md', hash: 'a1b2c3' },
        { path: 'questions.md', hash: 'd4e5f6' }, // older copy than coding's? same here
      ],
      sourceFiles: [
        { path: 'SKILL.md', hash: 'a1b2c3' },
        { path: 'questions.md', hash: 'ff0099' },
        { path: 'examples.md', hash: '0a0a0a' },
      ],
    },
  ],
  launch: {
    mcpMode: 'none',
    skipPermissions: 'true', // differs — security-sensitive
    claudeArgs: '--model claude-opus-4-1',
    attributionHeader: '0',
  },
};

export const writing: DiffProfile = {
  name: 'writing',
  // Identical to coding except launch config and MCP status — lets the
  // matrix variant show "equal" cells next to "different" ones.
  userMemory: coding.userMemory,
  agents: coding.agents,
  settings: coding.settings,
  mcp: [
    { name: 'context7', transport: 'http', status: 'connected' },
    { name: 'codegraph', transport: 'stdio', status: 'connected' },
    { name: 'playwright', transport: 'stdio', status: 'connected' }, // status differs
  ],
  skills: [
    {
      name: 'commit',
      source: '~/src/prompts/skills/commit',
      profileFiles: [{ path: 'SKILL.md', hash: '77aa11' }],
      sourceFiles: [{ path: 'SKILL.md', hash: '77aa11' }],
    },
  ],
  launch: {
    mcpMode: 'none',
    skipPermissions: 'false',
    claudeArgs: '--model claude-sonnet-4-5',
    attributionHeader: '0',
  },
};

export const PROFILES: DiffProfile[] = [coding, study, writing];
