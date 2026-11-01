/**
 * Watermark (task 11.2, WM-01…03): upload / drag-drop / paste PNG, JPG, JPEG, SVG; Show toggle (default on);
 * 9-grid position snap + drag on preview; size; opacity; replace / delete. Free tier: preview only.
 */
import { ImagePlus } from 'lucide-react';
import { api, errMsg } from '../../lib/api';
import { Button, Section, Slider, toast, Toggle } from '../../ui';
import { useEditor } from '../store';
import { edit, useP } from './common';

const GRID = [0.1, 0.5, 0.9];

export function WatermarkPanel() {
  const wm = useP((p) => p.watermark);
  const dir = useEditor((s) => s.dir);
  const upload = async () => {
    try {
      const r = await api.invoke<{ file: string } | null>('projects:importAsset', dir, 'watermark');
      if (r) edit(wm ? 'Replace watermark' : 'Add watermark', (p) => { p.watermark = { file: r.file, x: 0.9, y: 0.1, scale: 0.12, opacity: 0.85, visible: true, ...(p.watermark ? { x: p.watermark.x, y: p.watermark.y, scale: p.watermark.scale, opacity: p.watermark.opacity } : {}) }; });
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const onPaste = async (e: React.ClipboardEvent) => {
    const f = [...e.clipboardData.files].find((x) => /image\/(png|jpe?g|svg)/.test(x.type));
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const name = `watermark-${Date.now().toString(36)}.${f.type.includes('svg') ? 'svg' : f.type.includes('png') ? 'png' : 'jpg'}`;
    await api.invoke('projects:writeCache', dir, name, bytes);
    edit('Paste watermark', (p) => { p.watermark = { file: `cache/${name}`, x: 0.9, y: 0.1, scale: 0.12, opacity: 0.85, visible: true }; });
  };
  return (
    <div onPaste={onPaste} tabIndex={0} className="outline-none">
      <Section title="Watermark">
        {!wm ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line p-6 text-center text-xs text-muted"
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && !/^image\/(png|jpeg|svg\+xml|webp)$/.test(f.type)) { toast('Use a PNG, JPG, SVG or WebP image', 'error'); return; } if (f) { const bytes = new Uint8Array(await f.arrayBuffer()); const name = `watermark-${Date.now().toString(36)}.${f.name.split('.').pop()}`; await api.invoke('projects:writeCache', dir, name, bytes); edit('Add watermark', (p) => { p.watermark = { file: `cache/${name}`, x: 0.9, y: 0.1, scale: 0.12, opacity: 0.85, visible: true }; }); } }}>
            Drop a PNG / JPG / SVG here, paste it, or
            <Button size="sm" onClick={upload}><ImagePlus size={13} />Upload</Button>
            <Button size="sm" variant="ghost" onClick={() => edit('Add text watermark', (p) => { p.watermark = { file: '', text: '© Your brand', color: '#ffffff', x: 0.88, y: 0.92, scale: 0.12, opacity: 0.8, visible: true }; })}>Use text instead</Button>
          </div>
        ) : (
          <>
            <Toggle label="Show watermark" checked={wm.visible} onChange={(v) => edit('Show watermark', (p) => { p.watermark!.visible = v; })} />
            {wm.text !== undefined && (
              <>
                <input aria-label="Watermark text" className="h-8 rounded-lg border border-line bg-panel-2 px-2 text-[13px]" value={wm.text} onChange={(e) => edit('Watermark text', (p) => { p.watermark!.text = e.target.value; }, 'wmtext')} />
                <input aria-label="Watermark color" type="color" value={wm.color ?? '#ffffff'} onChange={(e) => edit('Watermark color', (p) => { p.watermark!.color = e.target.value; }, 'wmcolor')} />
              </>
            )}
            <div className="grid w-28 grid-cols-3 gap-1">
              {GRID.flatMap((y) => GRID.map((x) => (
                <button key={`${x}-${y}`} aria-label={`position ${x},${y}`} onClick={() => edit('Watermark position', (p) => { p.watermark!.x = x; p.watermark!.y = y; })}
                  className={`h-7 rounded border ${Math.abs(wm.x - x) < 0.02 && Math.abs(wm.y - y) < 0.02 ? 'border-accent bg-accent/30' : 'border-line'}`} />
              )))}
            </div>
            <Slider label="Size" value={wm.scale} min={0.03} max={0.6} onChange={(v) => edit('Watermark size', (p) => { p.watermark!.scale = v; }, 'wmsize')} format={(v) => `${Math.round(v * 100)}%`} />
            <Slider label="Opacity" value={wm.opacity} min={0.05} max={1} onChange={(v) => edit('Watermark opacity', (p) => { p.watermark!.opacity = v; }, 'wmop')} format={(v) => `${Math.round(v * 100)}%`} />
            <div className="flex gap-2">
              <Button size="sm" onClick={upload}>Replace</Button>
              <Button size="sm" variant="danger" onClick={() => edit('Delete watermark', (p) => { delete p.watermark; })}>Delete</Button>
            </div>
            <div className="text-[11px] text-muted">Drag the watermark on the preview to move it. Exporting a custom watermark requires a paid plan.</div>
          </>
        )}
      </Section>
    </div>
  );
}