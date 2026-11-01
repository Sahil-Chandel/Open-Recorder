/**
 * Bundled OFL fonts (task 8.2): text, captions and the UI render the same on every machine instead of
 * silently falling back to whatever system font exists. Canvas text only uses a web font once it has
 * loaded, so renderers await `ensureFonts()` before drawing (export) or redraw when it resolves (preview).
 */
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/400-italic.css';
import '@fontsource/inter/700-italic.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/bebas-neue/400.css';

/** Bundled first, then common system fonts (available on Windows and macOS unless noted). */
export const FONT_CHOICES = ['Inter', 'Montserrat', 'Bebas Neue', 'Arial', 'Georgia', 'Verdana', 'Trebuchet MS', 'Impact', 'Courier New', 'Segoe UI'] as const;

const BUNDLED = ['400 32px Inter', '700 32px Inter', 'italic 400 32px Inter', 'italic 700 32px Inter', '700 32px Montserrat', '800 32px Montserrat', '400 32px "Bebas Neue"'];

let loading: Promise<void> | null = null;
/** Resolves once the bundled faces are usable by canvas text (never rejects). */
export function ensureFonts(): Promise<void> {
  loading ??= Promise.all(BUNDLED.map((f) => document.fonts.load(f).catch(() => []))).then(() => undefined);
  return loading;
}
