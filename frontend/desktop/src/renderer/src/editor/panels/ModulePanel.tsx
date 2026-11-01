import type { ModuleId } from '../store';
import { AnimationsPanel } from './AnimationsPanel';
import { AnnotationPanel } from './AnnotationPanel';
import { AudioPanel } from './AudioPanel';
import { CameraPanel } from './CameraPanel';
import { CaptionsPanel } from './CaptionsPanel';
import { CursorPanel } from './CursorPanel';
import { KeysPanel } from './KeysPanel';
import { SmartCutPanel } from './SmartCutPanel';
import { VideoPanel } from './VideoPanel';
import { WatermarkPanel } from './WatermarkPanel';

export function ModulePanel({ module }: { module: ModuleId }) {
  switch (module) {
    case 'video': return <VideoPanel />;
    case 'cursor': return <CursorPanel />;
    case 'camera': return <CameraPanel />;
    case 'animations': return <AnimationsPanel />;
    case 'keys': return <KeysPanel />;
    case 'annotation': return <AnnotationPanel />;
    case 'audio': return <AudioPanel />;
    case 'captions': return <CaptionsPanel />;
    case 'smartcut': return <SmartCutPanel />;
    case 'watermark': return <WatermarkPanel />;
  }
}