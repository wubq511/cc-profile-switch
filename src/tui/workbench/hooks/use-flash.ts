import { useCallback, useEffect, useRef, useState } from 'react';

/** Footer flash message with a single tracked timer: a newer message cancels
 *  the older timer so it can never clear the newer text early, and unmount
 *  cancels whatever is pending — no stray setState across screens (issue #90).
 *  Extracted from app.tsx (issue #89). */
export function useFlash(): { flashMessage: string; flash: (message: string) => void } {
  const [flashMessage, setFlashMessage] = useState('');
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((message: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashMessage(message);
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null;
      setFlashMessage('');
    }, 2500);
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  return { flashMessage, flash };
}
