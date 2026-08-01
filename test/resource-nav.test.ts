import { describe, expect, it } from 'vitest';

import {
  initialResourceNavState,
  resourceNavReducer,
} from '../src/tui/workbench/resource-nav';

describe('resourceNavReducer', () => {
  it('starts idle', () => {
    const state = initialResourceNavState();
    expect(state.phase).toBe('idle');
    expect(state.category).toBeNull();
    expect(state.selectedIndex).toBe(0);
  });

  it('opens a category into the list phase', () => {
    const state = resourceNavReducer(initialResourceNavState(), {
      type: 'OPEN_CATEGORY',
      category: 'agents',
    });
    expect(state.phase).toBe('list');
    expect(state.category).toBe('agents');
    expect(state.selectedIndex).toBe(0);
  });

  it('moves the selection within the list, clamped at zero', () => {
    let state = resourceNavReducer(initialResourceNavState(), {
      type: 'OPEN_CATEGORY',
      category: 'agents',
    });
    state = resourceNavReducer(state, { type: 'NAV_DOWN' });
    state = resourceNavReducer(state, { type: 'NAV_DOWN' });
    expect(state.selectedIndex).toBe(2);
    state = resourceNavReducer(state, { type: 'NAV_UP' });
    state = resourceNavReducer(state, { type: 'NAV_UP' });
    state = resourceNavReducer(state, { type: 'NAV_UP' });
    expect(state.selectedIndex).toBe(0);
  });

  it('sets the selection index directly (search-hit jump)', () => {
    let state = resourceNavReducer(initialResourceNavState(), {
      type: 'OPEN_CATEGORY',
      category: 'agents',
    });
    state = resourceNavReducer(state, { type: 'SET_SELECTED_INDEX', index: 3 });
    expect(state.selectedIndex).toBe(3);
    state = resourceNavReducer(state, { type: 'SET_SELECTED_INDEX', index: -2 });
    expect(state.selectedIndex).toBe(0);
  });

  it('ignores navigation outside the list phase', () => {
    const idle = resourceNavReducer(initialResourceNavState(), { type: 'NAV_DOWN' });
    expect(idle.phase).toBe('idle');
    expect(idle.selectedIndex).toBe(0);
  });

  it('transitions list → preview → list via BACK', () => {
    let state = resourceNavReducer(initialResourceNavState(), {
      type: 'OPEN_CATEGORY',
      category: 'user-memory',
    });
    state = resourceNavReducer(state, { type: 'OPEN_PREVIEW' });
    expect(state.phase).toBe('preview');

    state = resourceNavReducer(state, { type: 'BACK' });
    expect(state.phase).toBe('list');
  });

  it('transitions list → diff → list via BACK', () => {
    let state = resourceNavReducer(initialResourceNavState(), {
      type: 'OPEN_CATEGORY',
      category: 'agents',
    });
    state = resourceNavReducer(state, { type: 'OPEN_DIFF' });
    expect(state.phase).toBe('diff');

    state = resourceNavReducer(state, { type: 'BACK' });
    expect(state.phase).toBe('list');
  });

  it('allows only agents to open the frontmatter editor', () => {
    const agents = resourceNavReducer(initialResourceNavState(), {
      type: 'OPEN_CATEGORY',
      category: 'agents',
    });
    const agentsEdit = resourceNavReducer(agents, { type: 'OPEN_AGENT_EDIT' });
    expect(agentsEdit.phase).toBe('agent-edit');

    const memory = resourceNavReducer(initialResourceNavState(), {
      type: 'OPEN_CATEGORY',
      category: 'user-memory',
    });
    const memoryEdit = resourceNavReducer(memory, { type: 'OPEN_AGENT_EDIT' });
    expect(memoryEdit.phase).toBe('list');
  });

  it('opens the copy picker and tracks the target profile', () => {
    let state = resourceNavReducer(initialResourceNavState(), {
      type: 'OPEN_CATEGORY',
      category: 'user-memory',
    });
    state = resourceNavReducer(state, { type: 'OPEN_COPY' });
    expect(state.phase).toBe('copy');

    state = resourceNavReducer(state, { type: 'SET_TARGET_PROFILE', profile: 'study' });
    expect(state.targetProfile).toBe('study');

    state = resourceNavReducer(state, { type: 'BACK' });
    expect(state.phase).toBe('list');
    expect(state.targetProfile).toBeNull();
  });

  it('scrolls preview and diff views with SCROLL_UP/DOWN', () => {
    let state = resourceNavReducer(initialResourceNavState(), {
      type: 'OPEN_CATEGORY',
      category: 'user-memory',
    });
    state = resourceNavReducer(state, { type: 'OPEN_PREVIEW' });
    state = resourceNavReducer(state, { type: 'SCROLL_DOWN' });
    state = resourceNavReducer(state, { type: 'SCROLL_DOWN' });
    expect(state.scrollOffset).toBe(2);
    state = resourceNavReducer(state, { type: 'SCROLL_UP' });
    expect(state.scrollOffset).toBe(1);
  });

  it('does not scroll in the list phase', () => {
    let state = resourceNavReducer(initialResourceNavState(), {
      type: 'OPEN_CATEGORY',
      category: 'agents',
    });
    state = resourceNavReducer(state, { type: 'SCROLL_DOWN' });
    expect(state.scrollOffset).toBe(0);
  });

  it('CLOSE returns to idle', () => {
    let state = resourceNavReducer(initialResourceNavState(), {
      type: 'OPEN_CATEGORY',
      category: 'agents',
    });
    state = resourceNavReducer(state, { type: 'OPEN_PREVIEW' });
    state = resourceNavReducer(state, { type: 'CLOSE' });
    expect(state.phase).toBe('idle');
    expect(state.category).toBeNull();
  });

  describe('search phase', () => {
    it('opens search from the list phase and collects a query', () => {
      let state = resourceNavReducer(initialResourceNavState(), {
        type: 'OPEN_CATEGORY',
        category: 'user-memory',
      });
      state = resourceNavReducer(state, { type: 'OPEN_SEARCH' });
      expect(state.phase).toBe('search');
      expect(state.searchQuery).toBe('');

      state = resourceNavReducer(state, { type: 'SEARCH_INPUT', char: 'r' });
      state = resourceNavReducer(state, { type: 'SEARCH_INPUT', char: 'e' });
      expect(state.searchQuery).toBe('re');

      state = resourceNavReducer(state, { type: 'SEARCH_BACKSPACE' });
      expect(state.searchQuery).toBe('r');
    });

    it('navigates search results', () => {
      let state = resourceNavReducer(initialResourceNavState(), {
        type: 'OPEN_CATEGORY',
        category: 'agents',
      });
      state = resourceNavReducer(state, { type: 'OPEN_SEARCH' });
      state = resourceNavReducer(state, { type: 'SEARCH_NAV_DOWN' });
      state = resourceNavReducer(state, { type: 'SEARCH_NAV_DOWN' });
      expect(state.searchSelectedIndex).toBe(2);
      state = resourceNavReducer(state, { type: 'SEARCH_NAV_UP' });
      expect(state.searchSelectedIndex).toBe(1);
    });

    it('returns to the list phase on BACK and clears the query', () => {
      let state = resourceNavReducer(initialResourceNavState(), {
        type: 'OPEN_CATEGORY',
        category: 'user-memory',
      });
      state = resourceNavReducer(state, { type: 'OPEN_SEARCH' });
      state = resourceNavReducer(state, { type: 'SEARCH_INPUT', char: 'x' });
      state = resourceNavReducer(state, { type: 'BACK' });
      expect(state.phase).toBe('list');
      expect(state.searchQuery).toBe('');
    });

    it('does not open search from the idle phase', () => {
      const state = resourceNavReducer(initialResourceNavState(), { type: 'OPEN_SEARCH' });
      expect(state.phase).toBe('idle');
    });
  });
});
