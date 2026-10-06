import { useEffect, useRef } from 'react';

interface ShortcutHandlers {
  onRestart?: () => void;
  onStartStop?: () => void;
  onToggleLogs?: () => void;
  onFocusSearch?: () => void;
  onEscape?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  onQuit?: () => void;
}

/**
 * 全局快捷键。handlers 放在 ref 里，保证只注册一次监听，
 * 不会因为每次渲染产生新对象而反复解绑/绑定。
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const isMac = navigator.platform.toUpperCase().includes('MAC');

    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      const handlers = ref.current;
      const run = (fn?: () => void) => {
        if (!fn) return false;
        event.preventDefault();
        fn();
        return true;
      };

      if (modifier) {
        const key = event.key.toLowerCase();
        if (key === 'r') return void run(handlers.onRestart);
        if (key === 's') return void run(handlers.onStartStop);
        if (key === 'l') return void run(handlers.onToggleLogs);
        if (key === 'f') return void run(handlers.onFocusSearch);
        if (key === '+' || key === '=') return void run(handlers.onZoomIn);
        if (key === '-') return void run(handlers.onZoomOut);
        if (key === '0') return void run(handlers.onZoomReset);
        if (key === 'q') return void run(handlers.onQuit);
        return;
      }

      if (event.key === 'Escape') void run(handlers.onEscape);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
