import { useEffect, useRef } from 'react';

/**
 * 快捷键。
 *
 * 键名格式：`n` / `Escape` / `alt+arrowup` / `shift+enter`（修饰键固定顺序 alt→shift→mod）。
 * 焦点在输入框里时一律不触发，唯一的例外是 Escape——否则用户进了输入框就出不来了。
 * 这条规则看着小，但不写的话，在快速新增框里打 "n" 会再弹一个新增框。
 */
export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

function keyOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  parts.push(event.key.toLowerCase());
  return parts.join('+');
}

export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      const combo = keyOf(event);
      const handler = mapRef.current[combo];
      if (!handler) return;

      const typing = isTypingTarget(event.target);
      if (typing && combo !== 'escape') return;

      event.preventDefault();
      handler(event);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
