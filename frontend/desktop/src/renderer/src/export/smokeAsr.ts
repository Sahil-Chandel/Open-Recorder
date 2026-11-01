/** Smoke-test hook: run local captions (Nano) + Smart Cut detection on the open project and log results. */
import { buildCaptionBlocks, detectFillers } from '@rec/shared';
import { recognise } from '../editor/panels/CaptionsPanel';

export async function runSmokeAsr(): Promise<void> {
  try {
    const t0 = performance.now();
    const r = await recognise('nano', 'en');
    const blocks = buildCaptionBlocks(r.words);
    console.log(`SMOKE_ASR ${JSON.stringify({ ok: true, ms: Math.round(performance.now() - t0), words: r.words.length, text: r.words.map((w) => w.w).join(' '), blocks: blocks.length, fillers: detectFillers(r.words, 'en').map((f) => f.text) })}`);
  } catch (e) {
    console.log(`SMOKE_ASR ${JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) })}`);
  }
}