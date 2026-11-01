/**
 * Video Enhancement (task 3.6, STY-01…05): canvas aspect + social labels, padding, inset, roundness, shadow,
 * background blur, backgrounds (wallpapers, gradients, colors, custom image), crop, fixed zoom part,
 * vertical full-screen adaptation, device frame.
 */
import { Check, Crop, ImagePlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { applySocialTarget, ASPECTS, canvasAspect, croppedSourceSize, SOCIAL_PRESETS, socialTarget, targetsByPlatform, type Aspect, type SocialPlatform, type SocialTarget } from '@rec/shared';
import { api, errMsg } from '../../lib/api';
import { Button, Section, Segmented, Select, Slider, toast, Toggle } from '../../ui';
import { GRADIENTS, SOLID_COLORS, WALLPAPERS } from '../../compositor/assets';
import { DEVICE_FRAMES } from '../deviceFrames';
import { useEditor } from '../store';
import { edit, Swatch, useP } from './common';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ASPECT_CHOICES: Aspect[] = ['auto', '16:9', '9:16', '1:1', '4:5', '4:3'];

/** Tiny proportional rectangle so formats are recognisable at a glance. */
function AspectGlyph({ aspect, active }: { aspect: Exclude<Aspect, 'auto'>; active?: boolean }) {
  const r = ASPECTS[aspect];
  const w = r >= 1 ? 16 : Math.round(16 * r), h = r >= 1 ? Math.round(16 / r) : 16;
  return <span aria-hidden className={`inline-block shrink-0 rounded-[2px] border ${active ? 'border-accent-2' : 'border-muted'}`} style={{ width: w, height: h }} />;
}

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * "Made for" platform picker (STY-01): platform → format (e.g. Instagram → Reels / Post 4:5 / Square).
 * Picking a format sets the aspect, fill mode and caption height; export then defaults to its size/fps.
 */
function CanvasSize() {
  const canvas = useP((p) => p.canvas);
  const source = useP((p) => p.source);
  const safeZones = useEditor((s) => s.safeZones);
  const active = socialTarget(canvas.target);
  const groups = useMemo(() => targetsByPlatform(), []);
  const [platform, setPlatform] = useState<SocialPlatform | null>(active?.platform ?? null);
  useEffect(() => { if (active) setPlatform(active.platform); }, [active?.platform]);
  const set = (label: string, f: (c: typeof canvas) => void, key?: string) => edit(label, (p) => f(p.canvas), key);
  const pick = (t: SocialTarget) => edit(`Canvas for ${t.name}`, (p) => {
    const src = croppedSourceSize(p.source.width, p.source.height, p.canvas.crop);
    applySocialTarget(t, p.canvas, { sourceAspect: src.w / src.h, hasCamera: !!p.source.tracks.camera && p.camera.visible, ...(p.captions ? { captionStyle: p.captions.style } : {}) });
  });
  const group = groups.find((g) => g.platform === platform);
  const src = croppedSourceSize(source.width, source.height, canvas.crop);
  const narrower = canvasAspect(canvas, source.width, source.height) < src.w / src.h - 0.01;

  return (
    <Section title="Canvas size">
      <div data-tour="made-for" className="text-[11px] font-medium uppercase tracking-wide text-muted">Made for</div>
      <div className="flex flex-wrap gap-1">
        {groups.filter((g) => g.platform !== 'generic').map((g) => (
          <button key={g.platform} aria-pressed={platform === g.platform}
            onClick={() => (g.targets.length === 1 ? (setPlatform(g.platform), pick(g.targets[0]!)) : setPlatform(platform === g.platform ? null : g.platform))}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${active?.platform === g.platform ? 'border-accent bg-accent/20 text-accent-2' : platform === g.platform ? 'border-accent/60' : 'border-line hover:border-muted'}`}>
            {g.name}
          </button>
        ))}
      </div>
      {group && group.targets.length > 1 && (
        <div className="grid grid-cols-2 gap-1">
          {group.targets.map((t) => {
            const on = active?.id === t.id;
            return (
              <button key={t.id} onClick={() => pick(t)} aria-pressed={on}
                className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left ${on ? 'border-accent bg-accent/15' : 'border-line hover:border-muted'}`}>
                <AspectGlyph aspect={t.aspect} active={on} />
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-medium">{t.format}</span>
                  <span className="block text-[10px] text-muted">{t.aspect} · {t.width}×{t.height}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {active ? (
        <div className="flex items-start gap-1.5 rounded-lg bg-accent/10 px-2 py-1.5 text-[11px]">
          <Check size={13} className="mt-px shrink-0 text-accent-2" />
          <span>
            <b>{active.name}</b> · {active.width}×{active.height} · {active.fps} fps{active.maxDurationSec ? ` · up to ${fmtDur(active.maxDurationSec)}` : ''}
            <span className="block text-muted">Export uses these settings by default.{active.durationNote ? ` ${active.durationNote}` : ''}</span>
          </span>
        </div>
      ) : (
        <div className="text-[11px] text-muted">{SOCIAL_PRESETS.find((s) => s.aspect === canvas.aspect)?.platforms.join(' · ') ?? 'Matches the recording'}</div>
      )}
      {active?.safeZone && (
        <Toggle label="Show platform safe zones" hint="Shades where the app's buttons and captions cover the video (preview only)" checked={safeZones} onChange={(v) => useEditor.getState().setSafeZones(v)} />
      )}
      <div className="pt-1 text-[11px] font-medium uppercase tracking-wide text-muted">Aspect ratio</div>
      <div className="grid grid-cols-6 gap-1">
        {ASPECT_CHOICES.map((a) => (
          <button key={a} onClick={() => set('Canvas aspect', (c) => { c.aspect = a; if (socialTarget(c.target)?.aspect !== a) delete c.target; })}
            className={`rounded-lg border py-1.5 text-[11px] ${canvas.aspect === a ? 'border-accent bg-accent/15' : 'border-line hover:border-muted'}`}>
            {a === 'auto' ? 'Auto' : a}
          </button>
        ))}
      </div>
      {narrower && (
        <Toggle label="Fill the frame" hint="Crop the recording to fill the canvas and follow the action instead of letter-boxing" checked={canvas.verticalFill} onChange={(v) => set('Fill frame', (c) => { c.verticalFill = v; })} />
      )}
    </Section>
  );
}

export function VideoPanel() {
  const canvas = useP((p) => p.canvas);
  const kind = useP((p) => p.source.kind);
  const dir = useEditor((s) => s.dir);
  const [bgTab, setBgTab] = useState<'wallpaper' | 'gradient' | 'color' | 'image' | 'video'>(canvas.background.type);
  const set = (label: string, f: (c: typeof canvas) => void, key?: string) => edit(label, (p) => f(p.canvas), key);

  return (
    <>
      <CanvasSize />
      <Section title="Frame">
        <Button onClick={() => window.dispatchEvent(new CustomEvent('editor:crop', { detail: 'screen' }))}><Crop size={14} />Crop recording{canvas.crop ? ' (on)' : ''}</Button>
        <Slider label="Padding" value={canvas.padding} min={0} max={0.3} onChange={(v) => set('Padding', (c) => { c.padding = v; }, 'pad')} format={pct} />
        <Slider label="Inset" value={canvas.inset} min={0} max={0.15} onChange={(v) => set('Inset', (c) => { c.inset = v; }, 'inset')} format={pct} />
        <Slider label="Roundness" value={canvas.roundness} min={0} max={1} onChange={(v) => set('Roundness', (c) => { c.roundness = v; }, 'round')} format={pct} />
        <Slider label="Shadow" value={canvas.shadow} min={0} max={1} onChange={(v) => set('Shadow', (c) => { c.shadow = v; }, 'shadow')} format={pct} />
        <Toggle label="Fixed zoom part" hint="Zooms stay on their focus point instead of panning with the cursor" checked={canvas.fixedZoom} onChange={(v) => set('Fixed zoom', (c) => { c.fixedZoom = v; })} />
        {(kind === 'android' || kind === 'ios') && (
          <Select label="Device frame" value={canvas.deviceFrame ?? 'none'} onChange={(v) => set('Device frame', (c) => { c.deviceFrame = v === 'none' ? undefined : v; })}
            options={[{ value: 'none', label: 'None' }, ...DEVICE_FRAMES.map((f) => ({ value: f.id, label: f.name }))]} />
        )}
      </Section>
      <Section title="Background">
        <Segmented size="sm" value={bgTab} onChange={setBgTab} options={[{ value: 'wallpaper', label: 'Wallpaper' }, { value: 'gradient', label: 'Gradient' }, { value: 'color', label: 'Color' }, { value: 'image', label: 'Image' }, { value: 'video', label: 'Video' }]} />
        <div className="grid grid-cols-4 gap-1.5">
          {bgTab === 'wallpaper' && WALLPAPERS.map((w) => (
            <Swatch key={w.id} title={w.name} active={canvas.background.type === 'wallpaper' && canvas.background.value === w.id}
              onClick={() => set('Background', (c) => { c.background = { type: 'wallpaper', value: w.id }; })}
              style={{ background: `linear-gradient(160deg, ${w.colors[0]}, ${w.colors[1]}, ${w.colors[2]})` }} />
          ))}
          {bgTab === 'gradient' && GRADIENTS.map((g) => (
            <Swatch key={g.id} title={g.name} active={canvas.background.type === 'gradient' && canvas.background.value === g.id}
              onClick={() => set('Background', (c) => { c.background = { type: 'gradient', value: g.id }; })}
              style={{ background: `linear-gradient(${g.angle + 90}deg, ${g.colors.join(',')})` }} />
          ))}
          {bgTab === 'color' && SOLID_COLORS.map((c0) => (
            <Swatch key={c0} title={c0} active={canvas.background.type === 'color' && canvas.background.value === c0}
              onClick={() => set('Background', (c) => { c.background = { type: 'color', value: c0 }; })} style={{ background: c0 }} />
          ))}
        </div>
        {bgTab === 'color' && (
          <input aria-label="Custom background color" type="color" value={canvas.background.type === 'color' ? canvas.background.value : '#111111'} onChange={(e) => set('Background', (c) => { c.background = { type: 'color', value: e.target.value }; }, 'bgcolor')} />
        )}
        {bgTab === 'image' && (
          <Button onClick={async () => {
            try {
              const r = await api.invoke<{ file: string } | null>('projects:importAsset', dir, 'background');
              if (r) set('Background image', (c) => { c.background = { type: 'image', value: r.file }; });
            } catch (e) { toast(errMsg(e), 'error'); }
          }}><ImagePlus size={14} />Upload image…</Button>
        )}
        {bgTab === 'video' && (
          <div className="flex flex-col gap-1.5">
            <Button onClick={async () => {
              try {
                const r = await api.invoke<{ file: string } | null>('projects:importAsset', dir, 'background-video');
                if (r) set('Video background', (c) => { c.background = { type: 'video', value: r.file }; });
              } catch (e) { toast(errMsg(e), 'error'); }
            }}><ImagePlus size={14} />{canvas.background.type === 'video' ? 'Replace video…' : 'Upload a looping video…'}</Button>
            <div className="text-[11px] text-muted">Plays muted and loops for the whole video. Short, calm clips (5–20 s) work best.</div>
          </div>
        )}
        <Slider label="Background blur" value={canvas.backgroundBlur} min={0} max={1} onChange={(v) => set('Background blur', (c) => { c.backgroundBlur = v; }, 'bgblur')} format={pct} />
      </Section>
    </>
  );
}
