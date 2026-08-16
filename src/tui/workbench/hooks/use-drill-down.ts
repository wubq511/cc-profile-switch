import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

import type { BulkCategory } from '../resources/bulk-ops-view';

/** Which full-pane resource surface the main pane is showing (issue #69/#94/
 *  #101). 'none' = the category card grid. Extracted from app.tsx (issue #89);
 *  the mapping from category key to drill kind lives in categories.ts. */
export type DrillDown =
  | { kind: 'none' }
  | { kind: 'autoMemory' }
  | { kind: 'bulk'; category: BulkCategory }
  | { kind: 'kv'; category: 'settings' | 'launchConfig'; focusKey?: string }
  | { kind: 'plugins' }
  | { kind: 'recovery' };

type UseDrillDownOptions = {
  setCapture: Dispatch<SetStateAction<boolean>>;
  setMainPaneFocus: Dispatch<SetStateAction<boolean>>;
};

/** Main-pane drill-down state (issue #89). Opening a drill always pairs with
 *  capturing app-level input; exiting releases the capture and returns focus
 *  to the category grid so the user can keep navigating. */
export function useDrillDown({ setCapture, setMainPaneFocus }: UseDrillDownOptions): {
  drillDown: DrillDown;
  openDrill: (drill: DrillDown) => void;
  exitDrillDown: () => void;
} {
  const [drillDown, setDrillDown] = useState<DrillDown>({ kind: 'none' });

  const openDrill = useCallback(
    (drill: DrillDown) => {
      setDrillDown(drill);
      setCapture(true);
    },
    [setCapture],
  );

  const exitDrillDown = useCallback(() => {
    setDrillDown({ kind: 'none' });
    setCapture(false);
    // Return focus to the category grid so the user can keep navigating.
    setMainPaneFocus(true);
  }, [setCapture, setMainPaneFocus]);

  return { drillDown, openDrill, exitDrillDown };
}
