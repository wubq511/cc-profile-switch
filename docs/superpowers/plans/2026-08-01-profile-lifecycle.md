# Profile Lifecycle Operations in the Workbench — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire profile lifecycle actions (create, copy, rename, default, validate, backup, remove) into the Workbench sidebar with inline prompts, all routing through existing core services.

**Architecture:** Add a lifecycle prompt state machine (`lifecycle.ts`) and wire it into the sidebar component. The sidebar gains an action hint bar and inline prompt rendering. All mutations call existing core services and then refresh the workbench data. No new core code.

**Tech Stack:** TypeScript, React (Ink 7), Vitest, existing core services (`profile-management.ts`, `profile.ts`, `validator.ts`, `profile-template.ts`).

## Global Constraints

- All user-facing strings in both `en.ts` and `zh.ts` locale files
- CLI command surface and its tests are unchanged
- All operations reuse existing core services; no duplication
- `useInput` requires TTY stdin — guard with `!headless && inkStdin.isTTY`
- Profile names validated through `validateProfileName` from `platform/path`
- Mutating actions refresh workbench data via `loadWorkbenchData`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/tui/workbench/lifecycle.ts` | Prompt state machine reducer, types, action definitions |
| `src/tui/workbench/sidebar.tsx` | Modified: action bar, inline prompts, key bindings |
| `src/tui/workbench/app.tsx` | Modified: pass `onDataRefresh` callback to sidebar |
| `src/tui/workbench/profile-data.ts` | Modified: expose `loadWorkbenchData` for refresh |
| `src/tui/workbench/i18n/en.ts` | Modified: add lifecycle locale keys |
| `src/tui/workbench/i18n/zh.ts` | Modified: add lifecycle locale keys |
| `src/tui/workbench/keymap.tsx` | Modified: add lifecycle key bindings to help overlay |
| `test/workbench-lifecycle.test.ts` | New: state machine reducer tests |
| `test/workbench-i18n.test.ts` | Existing: parity test auto-covers new keys |

---

### Task 1: Lifecycle state machine and types

**Files:**
- Create: `src/tui/workbench/lifecycle.ts`
- Test: `test/workbench-lifecycle.test.ts`

**Interfaces:**
- Produces: `LifecycleState`, `LifecycleAction`, `LifecyclePromptKind`, `lifecycleReducer`, `LIFECYCLE_ACTIONS`, `initialLifecycleState`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  initialLifecycleState,
  lifecycleReducer,
  type LifecycleState,
  type LifecycleAction,
} from '../src/tui/workbench/lifecycle';

describe('lifecycle reducer', () => {
  it('starts in idle state', () => {
    const state = initialLifecycleState();
    expect(state.phase).toBe('idle');
  });

  it('transitions idle → prompting on START_PROMPT', () => {
    const state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    expect(state.phase).toBe('prompting');
    expect(state.kind).toBe('rename');
    expect(state.profileName).toBe('coding');
    expect(state.input).toBe('');
  });

  it('transitions prompting → idle on CANCEL', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'CANCEL' });
    expect(state.phase).toBe('idle');
  });

  it('accumulates input on INPUT_CHAR', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'n' });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'e' });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'w' });
    expect(state.input).toBe('new');
  });

  it('deletes last char on BACKSPACE', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'a' });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'b' });
    state = lifecycleReducer(state, { type: 'BACKSPACE' });
    expect(state.input).toBe('a');
  });

  it('transitions prompting → executing on SUBMIT', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'n' });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    expect(state.phase).toBe('executing');
    expect(state.input).toBe('n');
  });

  it('transitions executing → success on EXECUTE_SUCCESS', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, { type: 'EXECUTE_SUCCESS', message: 'Renamed.' });
    expect(state.phase).toBe('success');
    expect(state.message).toBe('Renamed.');
  });

  it('transitions executing → error on EXECUTE_ERROR', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, { type: 'EXECUTE_ERROR', message: 'Name taken.' });
    expect(state.phase).toBe('error');
    expect(state.message).toBe('Name taken.');
  });

  it('transitions success → idle on DISMISS', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, { type: 'EXECUTE_SUCCESS', message: 'OK' });
    state = lifecycleReducer(state, { type: 'DISMISS' });
    expect(state.phase).toBe('idle');
  });

  it('transitions error → idle on DISMISS', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    state = lifecycleReducer(state, { type: 'EXECUTE_ERROR', message: 'Fail' });
    state = lifecycleReducer(state, { type: 'DISMISS' });
    expect(state.phase).toBe('idle');
  });

  it('handles create-from-template two-step flow', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'create',
      profileName: '',
    });
    expect(state.phase).toBe('prompting');
    expect(state.kind).toBe('create');
    expect(state.step).toBe(1); // step 1 = template picker

    // Select template (arrow down to 'study')
    state = lifecycleReducer(state, { type: 'SELECT_TEMPLATE', templateName: 'study' });
    expect(state.selectedTemplate).toBe('study');

    // Advance to step 2 = name input
    state = lifecycleReducer(state, { type: 'NEXT_STEP' });
    expect(state.step).toBe(2);

    // Type name
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'm' });
    state = lifecycleReducer(state, { type: 'INPUT_CHAR', char: 'y' });
    expect(state.input).toBe('my');

    // Submit
    state = lifecycleReducer(state, { type: 'SUBMIT' });
    expect(state.phase).toBe('executing');
    expect(state.input).toBe('my');
    expect(state.selectedTemplate).toBe('study');
  });

  it('handles immediate actions (validate, backup, default)', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_IMMEDIATE',
      kind: 'validate',
      profileName: 'coding',
    });
    expect(state.phase).toBe('executing');
    expect(state.kind).toBe('validate');
    expect(state.profileName).toBe('coding');
  });

  it('BACKSPACE on empty input is a no-op', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'rename',
      profileName: 'coding',
    });
    state = lifecycleReducer(state, { type: 'BACKSPACE' });
    expect(state.input).toBe('');
  });

  it('CANCEL from step 2 of create goes back to step 1', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'create',
      profileName: '',
    });
    state = lifecycleReducer(state, { type: 'SELECT_TEMPLATE', templateName: 'coding' });
    state = lifecycleReducer(state, { type: 'NEXT_STEP' });
    expect(state.step).toBe(2);
    state = lifecycleReducer(state, { type: 'CANCEL' });
    expect(state.step).toBe(1);
    expect(state.phase).toBe('prompting');
  });

  it('CANCEL from step 1 of create goes to idle', () => {
    let state = lifecycleReducer(initialLifecycleState(), {
      type: 'START_PROMPT',
      kind: 'create',
      profileName: '',
    });
    state = lifecycleReducer(state, { type: 'CANCEL' });
    expect(state.phase).toBe('idle');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/workbench-lifecycle.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Create `src/tui/workbench/lifecycle.ts`:

```ts
import { listProfileTemplates, type ProfileTemplateName } from '../../core/profile-template';

export type LifecyclePromptKind =
  | 'create'
  | 'copy'
  | 'rename'
  | 'remove'
  | 'validate'
  | 'backup'
  | 'default';

export type LifecyclePhase =
  | 'idle'
  | 'prompting'
  | 'executing'
  | 'success'
  | 'error';

export type LifecycleState = {
  phase: LifecyclePhase;
  kind: LifecyclePromptKind | null;
  profileName: string;
  input: string;
  step: number;
  selectedTemplate: ProfileTemplateName | null;
  message: string;
  findings: LifecycleFinding[] | null;
};

export type LifecycleFinding = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
};

export type LifecycleAction =
  | { type: 'START_PROMPT'; kind: LifecyclePromptKind; profileName: string }
  | { type: 'START_IMMEDIATE'; kind: LifecyclePromptKind; profileName: string }
  | { type: 'INPUT_CHAR'; char: string }
  | { type: 'BACKSPACE' }
  | { type: 'SELECT_TEMPLATE'; templateName: ProfileTemplateName }
  | { type: 'NEXT_STEP' }
  | { type: 'SUBMIT' }
  | { type: 'CANCEL' }
  | { type: 'EXECUTE_SUCCESS'; message: string }
  | { type: 'EXECUTE_ERROR'; message: string }
  | { type: 'SET_FINDINGS'; findings: LifecycleFinding[] }
  | { type: 'DISMISS' };

export function initialLifecycleState(): LifecycleState {
  return {
    phase: 'idle',
    kind: null,
    profileName: '',
    input: '',
    step: 1,
    selectedTemplate: null,
    message: '',
    findings: null,
  };
}

export function lifecycleReducer(state: LifecycleState, action: LifecycleAction): LifecycleState {
  switch (action.type) {
    case 'START_PROMPT': {
      return {
        ...initialLifecycleState(),
        phase: 'prompting',
        kind: action.kind,
        profileName: action.profileName,
        step: action.kind === 'create' ? 1 : 0,
      };
    }

    case 'START_IMMEDIATE': {
      return {
        ...initialLifecycleState(),
        phase: 'executing',
        kind: action.kind,
        profileName: action.profileName,
      };
    }

    case 'INPUT_CHAR': {
      if (state.phase !== 'prompting') return state;
      return { ...state, input: state.input + action.char };
    }

    case 'BACKSPACE': {
      if (state.phase !== 'prompting') return state;
      return { ...state, input: state.input.slice(0, -1) };
    }

    case 'SELECT_TEMPLATE': {
      if (state.phase !== 'prompting' || state.kind !== 'create') return state;
      return { ...state, selectedTemplate: action.templateName };
    }

    case 'NEXT_STEP': {
      if (state.phase !== 'prompting') return state;
      return { ...state, step: state.step + 1, input: '' };
    }

    case 'SUBMIT': {
      if (state.phase !== 'prompting') return state;
      return { ...state, phase: 'executing' };
    }

    case 'CANCEL': {
      if (state.phase === 'prompting' && state.kind === 'create' && state.step > 1) {
        return { ...state, step: state.step - 1, input: '' };
      }
      return initialLifecycleState();
    }

    case 'EXECUTE_SUCCESS': {
      if (state.phase !== 'executing') return state;
      return { ...state, phase: 'success', message: action.message };
    }

    case 'EXECUTE_ERROR': {
      if (state.phase !== 'executing') return state;
      return { ...state, phase: 'error', message: action.message };
    }

    case 'SET_FINDINGS': {
      return { ...state, findings: action.findings };
    }

    case 'DISMISS': {
      if (state.phase === 'success' || state.phase === 'error') {
        return initialLifecycleState();
      }
      return state;
    }

    default:
      return state;
  }
}

export const LIFECYCLE_ACTIONS = [
  { key: 'n', kind: 'create' as const, labelKey: 'lifecycle.create' as const },
  { key: 'c', kind: 'copy' as const, labelKey: 'lifecycle.copy' as const },
  { key: 'r', kind: 'rename' as const, labelKey: 'lifecycle.rename' as const },
  { key: 'd', kind: 'default' as const, labelKey: 'lifecycle.default' as const },
  { key: 'v', kind: 'validate' as const, labelKey: 'lifecycle.validate' as const },
  { key: 'b', kind: 'backup' as const, labelKey: 'lifecycle.backup' as const },
  { key: 'x', kind: 'remove' as const, labelKey: 'lifecycle.remove' as const },
] as const;

export const TEMPLATE_LIST = listProfileTemplates();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/workbench-lifecycle.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/tui/workbench/lifecycle.ts test/workbench-lifecycle.test.ts
git commit -m "feat: add lifecycle prompt state machine reducer (issue #56)"
```

---

### Task 2: i18n strings for lifecycle actions

**Files:**
- Modify: `src/tui/workbench/i18n/en.ts`
- Modify: `src/tui/workbench/i18n/zh.ts`
- Test: `test/workbench-i18n.test.ts` (existing parity test auto-covers)

**Interfaces:**
- Consumes: `LifecyclePromptKind` from Task 1
- Produces: new locale keys used by sidebar in Task 3

- [ ] **Step 1: Add lifecycle keys to en.ts**

Append to the `en` object in `src/tui/workbench/i18n/en.ts`:

```ts
  // Lifecycle actions
  'lifecycle.create': 'New profile',
  'lifecycle.copy': 'Copy',
  'lifecycle.rename': 'Rename',
  'lifecycle.default': 'Default',
  'lifecycle.validate': 'Validate',
  'lifecycle.backup': 'Backup',
  'lifecycle.remove': 'Remove',
  'lifecycle.prompt.rename': 'Rename to:',
  'lifecycle.prompt.copy': 'Copy to:',
  'lifecycle.prompt.remove': 'Type name to confirm:',
  'lifecycle.prompt.createName': 'Profile name:',
  'lifecycle.prompt.createTemplate': 'Select template:',
  'lifecycle.executing': 'Working…',
  'lifecycle.success': 'Done!',
  'lifecycle.error': 'Error',
  'lifecycle.findings.errors': 'errors',
  'lifecycle.findings.warnings': 'warnings',
  'lifecycle.default.set': 'Set as default',
  'lifecycle.default.cleared': 'Default cleared',
  'lifecycle.template.blank': 'blank',
```

- [ ] **Step 2: Add lifecycle keys to zh.ts**

Append to the `zh` object in `src/tui/workbench/i18n/zh.ts`:

```ts
  'lifecycle.create': '新建配置',
  'lifecycle.copy': '复制',
  'lifecycle.rename': '重命名',
  'lifecycle.default': '默认',
  'lifecycle.validate': '验证',
  'lifecycle.backup': '备份',
  'lifecycle.remove': '删除',
  'lifecycle.prompt.rename': '重命名为：',
  'lifecycle.prompt.copy': '复制到：',
  'lifecycle.prompt.remove': '输入名称确认：',
  'lifecycle.prompt.createName': '配置名称：',
  'lifecycle.prompt.createTemplate': '选择模板：',
  'lifecycle.executing': '处理中…',
  'lifecycle.success': '完成！',
  'lifecycle.error': '错误',
  'lifecycle.findings.errors': '错误',
  'lifecycle.findings.warnings': '警告',
  'lifecycle.default.set': '设为默认',
  'lifecycle.default.cleared': '已清除默认',
  'lifecycle.template.blank': '空白',
```

- [ ] **Step 3: Run i18n parity test**

Run: `npx vitest run test/workbench-i18n.test.ts`
Expected: PASS — parity test confirms zh has every en key and vice versa

- [ ] **Step 4: Commit**

```bash
git add src/tui/workbench/i18n/en.ts src/tui/workbench/i18n/zh.ts
git commit -m "feat: add lifecycle i18n strings for en and zh locales (issue #56)"
```

---

### Task 3: Wire lifecycle actions into sidebar

**Files:**
- Modify: `src/tui/workbench/sidebar.tsx`
- Modify: `src/tui/workbench/app.tsx`
- Modify: `src/tui/workbench/profile-data.ts`
- Modify: `src/tui/workbench/keymap.tsx`

**Interfaces:**
- Consumes: `lifecycleReducer`, `initialLifecycleState`, `LIFECYCLE_ACTIONS`, `TEMPLATE_LIST`, `LifecycleState`, `LifecycleAction` from Task 1
- Consumes: locale keys from Task 2
- Consumes: `createProfile` from `core/profile`, `copyProfile`/`renameProfile`/`removeProfile`/`setDefaultProfile`/`clearDefaultProfile` from `core/profile-management`, `validateProfile` from `core/validator`, `backupProfile` from `core/profile`, `listProfileTemplates` from `core/profile-template`
- Produces: sidebar with action bar + inline prompts, `onDataRefresh` callback type

- [ ] **Step 1: Add onDataRefresh to profile-data.ts**

In `src/tui/workbench/profile-data.ts`, the `loadWorkbenchData` function is already exported. No changes needed — it's already the refresh mechanism. Verify it's exported and accessible.

- [ ] **Step 2: Update Sidebar props to accept onAction callback**

Modify `src/tui/workbench/sidebar.tsx`:

Add new prop:
```ts
type SidebarProps = {
  profiles: WorkbenchProfile[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  width: number;
  height: number;
  capture: boolean;
  headless?: boolean;
  onAction?: (action: LifecycleAction, profileName: string, input: string, selectedTemplate: string | null) => Promise<void>;
};
```

- [ ] **Step 3: Add lifecycle state and key bindings to sidebar**

In `sidebar.tsx`, add lifecycle state management:

```ts
import {
  initialLifecycleState,
  lifecycleReducer,
  LIFECYCLE_ACTIONS,
  TEMPLATE_LIST,
  type LifecycleState,
  type LifecycleAction,
} from './lifecycle';
```

Add state:
```ts
const [lifecycle, setLifecycle] = useState<LifecycleState>(initialLifecycleState);
const [templateIndex, setTemplateIndex] = useState(0);
```

Add lifecycle key handling in the `useInput` callback (before the existing navigation keys, after the `capture` guard):

```ts
// Lifecycle action keys (only when idle and a profile is selected)
if (lifecycle.phase === 'idle' && !searchFocused) {
  for (const act of LIFECYCLE_ACTIONS) {
    if (input === act.key) {
      const profile = filtered[filteredIndex(selectedIndex)];
      if (!profile) return;

      if (act.kind === 'validate' || act.kind === 'backup' || act.kind === 'default') {
        // Immediate actions
        setLifecycle(lifecycleReducer(lifecycle, {
          type: 'START_IMMEDIATE',
          kind: act.kind,
          profileName: profile.name,
        }));
        onAction?.({ type: 'START_IMMEDIATE', kind: act.kind, profileName: profile.name }, profile.name, '', null);
      } else {
        // Prompting actions
        setLifecycle(lifecycleReducer(lifecycle, {
          type: 'START_PROMPT',
          kind: act.kind,
          profileName: profile.name,
        }));
        if (act.kind === 'create') {
          setTemplateIndex(0);
        }
      }
      return;
    }
  }
}

// Lifecycle prompt input handling
if (lifecycle.phase === 'prompting') {
  if (key.escape) {
    setLifecycle(lifecycleReducer(lifecycle, { type: 'CANCEL' }));
    return;
  }
  if (lifecycle.kind === 'create' && lifecycle.step === 1) {
    // Template picker: arrow keys cycle templates
    if (key.upArrow) {
      setTemplateIndex((i) => (i > 0 ? i - 1 : TEMPLATE_LIST.length - 1));
      return;
    }
    if (key.downArrow) {
      setTemplateIndex((i) => (i < TEMPLATE_LIST.length - 1 ? i + 1 : 0));
      return;
    }
    if (key.return) {
      const template = TEMPLATE_LIST[templateIndex] ?? 'general';
      setLifecycle(lifecycleReducer(lifecycle, { type: 'SELECT_TEMPLATE', templateName: template }));
      setLifecycle(lifecycleReducer(lifecycle, { type: 'NEXT_STEP' }));
      return;
    }
    return; // block other input during template picker
  }
  if (key.backspace || key.delete) {
    setLifecycle(lifecycleReducer(lifecycle, { type: 'BACKSPACE' }));
    return;
  }
  if (key.return) {
    setLifecycle(lifecycleReducer(lifecycle, { type: 'SUBMIT' }));
    onAction?.(
      { type: 'SUBMIT' },
      lifecycle.profileName,
      lifecycle.input,
      lifecycle.selectedTemplate,
    );
    return;
  }
  if (!key.ctrl && !key.meta && input.length === 1) {
    setLifecycle(lifecycleReducer(lifecycle, { type: 'INPUT_CHAR', char: input }));
    return;
  }
  return;
}

// Dismiss success/error
if (lifecycle.phase === 'success' || lifecycle.phase === 'error') {
  if (key.escape || key.return || input === ' ') {
    setLifecycle(lifecycleReducer(lifecycle, { type: 'DISMISS' }));
    return;
  }
}
```

- [ ] **Step 4: Render action bar and inline prompts**

In the sidebar JSX, add the action bar below the profile list and above the border bottom. Replace the current return with one that includes:

After the profile list `<Box>`, add:

```tsx
// Action hint bar (when idle)
lifecycle.phase === 'idle' && React.createElement(
  Box,
  { paddingX: 1, flexDirection: 'column' },
  React.createElement(
    Text,
    { dimColor: true },
    LIFECYCLE_ACTIONS.map((a) => `[${a.key}]${t(a.labelKey)}`).join(' '),
  ),
),

// Inline prompt (when prompting)
lifecycle.phase === 'prompting' && React.createElement(
  Box,
  { paddingX: 1, flexDirection: 'column' },
  lifecycle.kind === 'create' && lifecycle.step === 1
    ? React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, { bold: true }, t('lifecycle.prompt.createTemplate')),
        ...TEMPLATE_LIST.map((tmpl, i) =>
          React.createElement(
            Text,
            { key: tmpl, color: i === templateIndex ? 'cyan' : undefined, bold: i === templateIndex },
            `${i === templateIndex ? '▸ ' : '  '}${tmpl}`,
          ),
        ),
      )
    : React.createElement(
        Box,
        null,
        React.createElement(Text, { bold: true }, promptLabel(lifecycle.kind, t)),
        React.createElement(Text, { color: 'cyan' }, `${lifecycle.input}█`),
      ),
),

// Executing indicator
lifecycle.phase === 'executing' && React.createElement(
  Box,
  { paddingX: 1 },
  React.createElement(Text, { color: 'yellow' }, t('lifecycle.executing')),
),

// Success message
lifecycle.phase === 'success' && React.createElement(
  Box,
  { paddingX: 1 },
  React.createElement(Text, { color: 'green' }, `${t('lifecycle.success')} ${lifecycle.message}`),
),

// Error message
lifecycle.phase === 'error' && React.createElement(
  Box,
  { paddingX: 1, flexDirection: 'column' },
  React.createElement(Text, { color: 'red' }, `${t('lifecycle.error')}: ${lifecycle.message}`),
  React.createElement(Text, { dimColor: true }, t('keymap.esc')),
),

// Validate findings (rendered when findings are present)
lifecycle.findings !== null && lifecycle.findings.length > 0 && React.createElement(
  Box,
  { paddingX: 1, flexDirection: 'column' },
  ...lifecycle.findings.map((f, i) =>
    React.createElement(
      Text,
      { key: i, color: f.severity === 'error' ? 'red' : 'yellow' },
      `[${f.severity}] ${f.code}: ${f.message}`,
    ),
  ),
),
```

Add the `promptLabel` helper inside the component or as a module-level function:

```ts
function promptLabel(kind: LifecyclePromptKind | null, t: (key: string) => string): string {
  switch (kind) {
    case 'rename': return t('lifecycle.prompt.rename');
    case 'copy': return t('lifecycle.prompt.copy');
    case 'remove': return t('lifecycle.prompt.remove');
    case 'create': return t('lifecycle.prompt.createName');
    default: return '';
  }
}
```

- [ ] **Step 5: Wire onAction in app.tsx**

In `src/tui/workbench/app.tsx`, add the `onAction` handler and pass it to `Sidebar`:

```ts
import {
  createProfile,
  backupProfile,
} from '../../core/profile';
import {
  copyProfile,
  renameProfile,
  removeProfile,
  setDefaultProfile,
  clearDefaultProfile,
} from '../../core/profile-management';
import { validateProfile } from '../../core/validator';
import { loadWorkbenchData } from './profile-data';
```

Add state for data refresh:
```ts
const [workbenchData, setWorkbenchData] = useState(data);
```

Add the `onAction` callback:
```ts
const handleLifecycleAction = useCallback(async (
  action: LifecycleAction,
  profileName: string,
  input: string,
  selectedTemplate: string | null,
) => {
  if (action.type !== 'SUBMIT' && action.type !== 'START_IMMEDIATE') return;

  const appHomePath = getAppHomePaths().appHomePath;

  try {
    if (lifecycle.kind === 'create') {
      await createProfile({
        appHomePath,
        name: input,
        template: (selectedTemplate ?? 'general') as ProfileTemplateName,
      });
      setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: `"${input}" created` }));
    } else if (lifecycle.kind === 'copy') {
      await copyProfile({ appHomePath, from: profileName, to: input });
      setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: `Copied to "${input}"` }));
    } else if (lifecycle.kind === 'rename') {
      await renameProfile({ appHomePath, oldName: profileName, newName: input });
      setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: `Renamed to "${input}"` }));
    } else if (lifecycle.kind === 'remove') {
      await removeProfile({ appHomePath, name: profileName, confirmation: input });
      setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: `"${profileName}" removed` }));
    } else if (lifecycle.kind === 'default') {
      const profile = workbenchData.profiles.find((p) => p.name === profileName);
      if (profile?.isDefault) {
        await clearDefaultProfile({ appHomePath });
        setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: t('lifecycle.default.cleared') }));
      } else {
        await setDefaultProfile({ appHomePath, name: profileName });
        setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: t('lifecycle.default.set') }));
      }
    } else if (lifecycle.kind === 'validate') {
      const result = await validateProfile({ appHomePath, name: profileName });
      const findings = result.findings.map((f) => ({
        severity: f.severity,
        code: f.code,
        message: f.message,
      }));
      setLifecycle(lifecycleReducer(lifecycle, { type: 'SET_FINDINGS', findings }));
      if (findings.length === 0) {
        setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: 'Valid' }));
      } else {
        setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: `${findings.filter((f) => f.severity === 'error').length} ${t('lifecycle.findings.errors')}, ${findings.filter((f) => f.severity === 'warning').length} ${t('lifecycle.findings.warnings')}` }));
      }
    } else if (lifecycle.kind === 'backup') {
      await backupProfile({ appHomePath, name: profileName });
      setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_SUCCESS', message: `"${profileName}" backed up` }));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLifecycle(lifecycleReducer(lifecycle, { type: 'EXECUTE_ERROR', message }));
    return;
  }

  // Refresh data after any mutation
  if (lifecycle.kind !== 'validate') {
    try {
      const freshData = await loadWorkbenchData(appHomePath);
      setWorkbenchData(freshData);
    } catch {
      // refresh failure is non-fatal
    }
  }
}, [lifecycle, workbenchData, t]);
```

Pass `workbenchData.profiles` instead of `data.profiles` to `Sidebar`, and pass `onAction={handleLifecycleAction}`.

- [ ] **Step 6: Add lifecycle keys to keymap overlay**

In `src/tui/workbench/keymap.tsx`, add lifecycle key bindings to the `KEYBINDINGS` array:

```ts
  { key: 'n', group: 'actions' as const, labelKey: 'lifecycle.create' as const },
  { key: 'c', group: 'actions' as const, labelKey: 'lifecycle.copy' as const },
  { key: 'r', group: 'actions' as const, labelKey: 'lifecycle.rename' as const },
  { key: 'd', group: 'actions' as const, labelKey: 'lifecycle.default' as const },
  { key: 'v', group: 'actions' as const, labelKey: 'lifecycle.validate' as const },
  { key: 'b', group: 'actions' as const, labelKey: 'lifecycle.backup' as const },
  { key: 'x', group: 'actions' as const, labelKey: 'lifecycle.remove' as const },
```

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass (existing + new lifecycle reducer tests)

- [ ] **Step 9: Run lint**

Run: `npx eslint src/tui/workbench/`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add src/tui/workbench/sidebar.tsx src/tui/workbench/app.tsx src/tui/workbench/profile-data.ts src/tui/workbench/keymap.tsx
git commit -m "feat: wire lifecycle actions into sidebar with inline prompts (issue #56)"
```

---

### Task 4: Auto-dismiss success messages

**Files:**
- Modify: `src/tui/workbench/sidebar.tsx`

**Interfaces:**
- Consumes: `LifecycleState` from Task 1

- [ ] **Step 1: Add useEffect for auto-dismiss**

In `sidebar.tsx`, add a `useEffect` that auto-dismisses the success state after 1.5 seconds:

```ts
useEffect(() => {
  if (lifecycle.phase !== 'success') return;
  const timer = setTimeout(() => {
    setLifecycle(lifecycleReducer(lifecycle, { type: 'DISMISS' }));
  }, 1500);
  return () => clearTimeout(timer);
}, [lifecycle.phase, lifecycle.message]);
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/tui/workbench/sidebar.tsx
git commit -m "feat: auto-dismiss lifecycle success messages after 1.5s (issue #56)"
```

---

### Task 5: Integration test — lifecycle actions render correctly

**Files:**
- Modify: `test/workbench-render.test.tsx`

**Interfaces:**
- Consumes: `WorkbenchApp` from existing, `WorkbenchData` from existing

- [ ] **Step 1: Add test for action bar rendering**

In `test/workbench-render.test.tsx`, add:

```ts
it('renders lifecycle action hints in sidebar', async () => {
  const stdout = new FakeTtyStdout();
  const instance = render(
    React.createElement(WorkbenchApp, { data: sampleData, initialLocale: 'en', headless: true }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: dummyStdin() as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  await instance.waitUntilRenderFlush();
  const output = stripAnsi(stdout.output);
  expect(output).toContain('[n]');
  expect(output).toContain('[c]');
  expect(output).toContain('[r]');
  expect(output).toContain('[d]');
  expect(output).toContain('[v]');
  expect(output).toContain('[b]');
  expect(output).toContain('[x]');
  instance.unmount();
  await instance.waitUntilExit();
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run test/workbench-render.test.tsx`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/workbench-render.test.tsx
git commit -m "test: verify lifecycle action hints render in sidebar (issue #56)"
```

---

### Task 6: Final validation

**Files:** None (verification only)

- [ ] **Step 1: Run full check**

Run: `npm run check`
Expected: lint passes, all tests pass, build succeeds

- [ ] **Step 2: Verify i18n parity**

Run: `npx vitest run test/workbench-i18n.test.ts`
Expected: PASS — both locales have all keys, no empty values

- [ ] **Step 3: Verify lifecycle reducer tests**

Run: `npx vitest run test/workbench-lifecycle.test.ts`
Expected: PASS — all state machine tests pass

- [ ] **Step 4: Verify render tests**

Run: `npx vitest run test/workbench-render.test.tsx`
Expected: PASS — action bar renders correctly

- [ ] **Step 5: Commit (if any fixes were needed)**

Only if changes were needed during validation.
