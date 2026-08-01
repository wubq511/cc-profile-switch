import type { ResourceCategory } from '../../core/resource';

export type ResourceNavPhase =
  | 'idle'          // category card grid
  | 'list'          // drilling into a category
  | 'preview'       // viewing a resource
  | 'diff'          // diff view
  | 'agent-edit'    // agent frontmatter editor
  | 'copy'          // copy target picker
  | 'search';       // cross-Profile resource search

export type ResourceNavState = {
  phase: ResourceNavPhase;
  category: ResourceCategory | null;
  /** Selected row index in the list view. */
  selectedIndex: number;
  scrollOffset: number;
  diffProfile: string | null;
  targetProfile: string | null;
  searchQuery: string;
  searchSelectedIndex: number;
};

export type ResourceNavAction =
  | { type: 'OPEN_CATEGORY'; category: ResourceCategory }
  | { type: 'NAV_UP' }
  | { type: 'NAV_DOWN' }
  | { type: 'SET_SELECTED_INDEX'; index: number }
  | { type: 'OPEN_PREVIEW' }
  | { type: 'OPEN_DIFF' }
  | { type: 'OPEN_AGENT_EDIT' }
  | { type: 'OPEN_COPY' }
  | { type: 'OPEN_SEARCH' }
  | { type: 'SEARCH_INPUT'; char: string }
  | { type: 'SEARCH_BACKSPACE' }
  | { type: 'SEARCH_CLEAR' }
  | { type: 'SEARCH_NAV_UP' }
  | { type: 'SEARCH_NAV_DOWN' }
  | { type: 'SET_DIFF_PROFILE'; profile: string }
  | { type: 'SET_TARGET_PROFILE'; profile: string }
  | { type: 'SCROLL_UP' }
  | { type: 'SCROLL_DOWN' }
  | { type: 'BACK' }
  | { type: 'CLOSE' };

export function initialResourceNavState(): ResourceNavState {
  return {
    phase: 'idle',
    category: null,
    selectedIndex: 0,
    scrollOffset: 0,
    diffProfile: null,
    targetProfile: null,
    searchQuery: '',
    searchSelectedIndex: 0,
  };
}

export function resourceNavReducer(
  state: ResourceNavState,
  action: ResourceNavAction,
): ResourceNavState {
  switch (action.type) {
    case 'OPEN_CATEGORY':
      return {
        ...initialResourceNavState(),
        phase: 'list',
        category: action.category,
      };

    case 'NAV_UP':
      if (state.phase !== 'list') return state;
      return { ...state, selectedIndex: Math.max(0, state.selectedIndex - 1) };

    case 'NAV_DOWN':
      if (state.phase !== 'list') return state;
      return { ...state, selectedIndex: state.selectedIndex + 1 };

    case 'SET_SELECTED_INDEX':
      if (state.phase !== 'list') return state;
      return { ...state, selectedIndex: Math.max(0, action.index) };

    case 'OPEN_PREVIEW':
      if (state.phase !== 'list') return state;
      return { ...state, phase: 'preview', scrollOffset: 0 };

    case 'OPEN_DIFF':
      if (state.phase !== 'list' && state.phase !== 'preview') return state;
      return { ...state, phase: 'diff', scrollOffset: 0 };

    case 'OPEN_AGENT_EDIT':
      if (state.phase !== 'list' || state.category !== 'agents') return state;
      return { ...state, phase: 'agent-edit' };

    case 'OPEN_COPY':
      if (state.phase !== 'list' && state.phase !== 'preview') return state;
      return { ...state, phase: 'copy', targetProfile: null };

    case 'OPEN_SEARCH':
      if (state.phase !== 'list') return state;
      return { ...state, phase: 'search', searchQuery: '', searchSelectedIndex: 0 };

    case 'SEARCH_INPUT':
      if (state.phase !== 'search') return state;
      return { ...state, searchQuery: state.searchQuery + action.char, searchSelectedIndex: 0 };

    case 'SEARCH_BACKSPACE':
      if (state.phase !== 'search') return state;
      return { ...state, searchQuery: state.searchQuery.slice(0, -1), searchSelectedIndex: 0 };

    case 'SEARCH_CLEAR':
      if (state.phase !== 'search') return state;
      return { ...state, searchQuery: '', searchSelectedIndex: 0 };

    case 'SEARCH_NAV_UP':
      if (state.phase !== 'search') return state;
      return { ...state, searchSelectedIndex: Math.max(0, state.searchSelectedIndex - 1) };

    case 'SEARCH_NAV_DOWN':
      if (state.phase !== 'search') return state;
      return { ...state, searchSelectedIndex: state.searchSelectedIndex + 1 };

    case 'SET_DIFF_PROFILE':
      if (state.phase !== 'diff') return state;
      return { ...state, diffProfile: action.profile, scrollOffset: 0 };

    case 'SET_TARGET_PROFILE':
      if (state.phase !== 'copy') return state;
      return { ...state, targetProfile: action.profile };

    case 'SCROLL_UP':
      if (state.phase !== 'preview' && state.phase !== 'diff') return state;
      return { ...state, scrollOffset: Math.max(0, state.scrollOffset - 1) };

    case 'SCROLL_DOWN':
      if (state.phase !== 'preview' && state.phase !== 'diff') return state;
      return { ...state, scrollOffset: state.scrollOffset + 1 };

    case 'BACK':
      if (state.phase === 'preview') {
        return { ...state, phase: 'list', scrollOffset: 0 };
      }
      if (state.phase === 'diff') {
        return { ...state, phase: 'list', diffProfile: null, scrollOffset: 0 };
      }
      if (state.phase === 'agent-edit') {
        return { ...state, phase: 'list' };
      }
      if (state.phase === 'copy') {
        return { ...state, phase: 'list', targetProfile: null };
      }
      if (state.phase === 'search') {
        return { ...state, phase: 'list', searchQuery: '', searchSelectedIndex: 0 };
      }
      if (state.phase === 'list') {
        return initialResourceNavState();
      }
      return state;

    case 'CLOSE':
      return initialResourceNavState();

    default:
      return state;
  }
}
