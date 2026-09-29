/**
 * Haptic Vibration Utility for mobile devices and supported browsers.
 * Provides tactile feedback for buttons, touch gestures, voice state transitions, and UI actions.
 */

export type HapticType =
  | "light"
  | "selection"
  | "medium"
  | "heavy"
  | "success"
  | "warning"
  | "error";

const HAPTIC_PATTERNS: Record<HapticType, number | number[]> = {
  light: 12,
  selection: 18,
  medium: 30,
  heavy: 55,
  success: [15, 40, 20],
  warning: [25, 40, 25],
  error: [40, 50, 40],
};

let lastHapticTime = 0;

/**
 * Triggers a tactile vibration on supported devices.
 */
export function triggerHaptic(type: HapticType = "light"): void {
  try {
    if (typeof window === "undefined" || !("vibrate" in navigator)) {
      return;
    }

    const now = Date.now();
    // Throttle repeated triggers within 40ms to keep tactile feel sharp
    if (now - lastHapticTime < 40 && type === "light") {
      return;
    }
    lastHapticTime = now;

    const pattern = HAPTIC_PATTERNS[type] || 15;
    navigator.vibrate(pattern);
  } catch {
    // Gracefully ignore devices/browsers that block navigator.vibrate
  }
}

export const hapticLight = () => triggerHaptic("light");
export const hapticSelection = () => triggerHaptic("selection");
export const hapticMedium = () => triggerHaptic("medium");
export const hapticHeavy = () => triggerHaptic("heavy");
export const hapticSuccess = () => triggerHaptic("success");
export const hapticWarning = () => triggerHaptic("warning");
export const hapticError = () => triggerHaptic("error");

/**
 * Initializes a global pointerdown event listener that ensures all buttons,
 * interactive role="button" elements, tabs, and clickable controls vibrate automatically.
 */
export function setupGlobalHaptics(): () => void {
  if (typeof window === "undefined") return () => {};

  const handlePointerDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    // Check if clicked element or its ancestor is a button or clickable control
    const clickable = target.closest<HTMLElement>(
      'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], [data-haptic], .cursor-pointer'
    );

    if (clickable) {
      const customType = clickable.getAttribute("data-haptic") as HapticType | null;
      triggerHaptic(customType || "light");
    }
  };

  window.addEventListener("pointerdown", handlePointerDown, { passive: true });

  return () => {
    window.removeEventListener("pointerdown", handlePointerDown);
  };
}
