/**
 * Camera person-mask provider (CAM-09, §6.10). Preview & export ask for a mask per camera frame.
 * The default provider uses the cached mask video produced by the background-removal pre-pass
 * (cache/camera.mask.webm, grayscale), sampled at the same source time; null when not prepared yet.
 */
export interface MaskProvider {
  maskFor(camera: HTMLVideoElement | VideoFrame, srcTime: number): TexImageSource | null;
}

class CachedMaskVideo implements MaskProvider {
  private video: HTMLVideoElement | null = null;
  private url = '';

  setSource(url: string | null): void {
    if (url === this.url) return;
    this.url = url ?? '';
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
    }
    this.video = null;
    if (!url) return;
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.src = url;
    this.video = v;
  }

  maskFor(_camera: HTMLVideoElement | VideoFrame, srcTime: number): TexImageSource | null {
    const v = this.video;
    if (!v || v.readyState < 2) return null;
    if (Math.abs(v.currentTime - srcTime) > 1 / 30) v.currentTime = Math.max(0, srcTime);
    return v;
  }
}

export const cameraMaskProvider = new CachedMaskVideo();
