/**
 * Fixes an app-wide UX issue: when the mouse is over a focused
 * <input type="number"> and the user scrolls the mouse wheel (intending
 * to scroll the page/background), the browser instead increments or
 * decrements the input's value.
 *
 * This listener intercepts wheel events over number inputs, stops the
 * value from changing, and manually forwards the scroll to the nearest
 * scrollable ancestor (or the window) so the background still scrolls
 * as expected. The input is NOT blurred - it stays focused.
 *
 * Registered once, globally, in main.tsx - no per-input changes needed.
 */

function isNumberInput(target: EventTarget | null): target is HTMLInputElement {
  return (
    target instanceof HTMLInputElement &&
    target.type === "number"
  );
}

function findScrollableAncestor(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;

  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    const canScrollY =
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight;

    if (canScrollY) {
      return node;
    }

    node = node.parentElement;
  }

  return null;
}

function handleWheelOverNumberInput(event: WheelEvent) {
  if (!isNumberInput(event.target)) {
    return;
  }

  // Only intervene when the field is actually focused - that's the only
  // state in which the browser hijacks the wheel event to change the value.
  if (document.activeElement !== event.target) {
    return;
  }

  // Stop the browser's default "change value on scroll" behavior.
  event.preventDefault();

  // Manually forward the scroll to whatever the user actually meant to
  // scroll - the nearest scrollable container, or the window as a fallback.
  const scrollTarget = findScrollableAncestor(event.target);

  if (scrollTarget) {
    scrollTarget.scrollBy({ top: event.deltaY, left: event.deltaX });
  } else {
    window.scrollBy({ top: event.deltaY, left: event.deltaX });
  }
}

let initialized = false;

export function initNumberInputScrollFix() {
  if (initialized) return;
  initialized = true;

  // Must be a non-passive listener so preventDefault() actually works.
  document.addEventListener("wheel", handleWheelOverNumberInput, {
    passive: false,
  });
}
