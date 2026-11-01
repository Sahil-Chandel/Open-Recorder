import { pathToFileURL } from 'node:url';

/**
 * URL of a renderer hash route: the Vite dev server under `npm run dev`, otherwise the packaged index.html.
 * pathToFileURL escapes '#', '%' and spaces, so an install folder or user name containing them can't cut the
 * file path short (a raw '#' would turn the rest of the path into the URL fragment and leave the window blank).
 */
export function rendererUrl(indexHtml: string, route: string, query: Record<string, string> = {}, devServer?: string): string {
  const qs = new URLSearchParams(query).toString();
  const hash = `#/${route}${qs ? `?${qs}` : ''}`;
  return devServer ? `${devServer}/index.html${hash}` : `${pathToFileURL(indexHtml).href}${hash}`;
}
