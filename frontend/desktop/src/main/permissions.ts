/**
 * Permission status + deep links (task 2.9, SET-09). Windows: privacy toggles for camera / mic.
 * macOS: TCC status via systemPreferences; Accessibility through isTrustedAccessibilityClient.
 */
import { shell, systemPreferences } from 'electron';

export type PermKind = 'screen' | 'camera' | 'microphone' | 'accessibility';
export type PermStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

export function permissionStatus(): Record<PermKind, PermStatus> {
  const media = (k: 'camera' | 'microphone' | 'screen'): PermStatus => {
    try {
      return systemPreferences.getMediaAccessStatus(k) as PermStatus;
    } catch {
      return 'unknown';
    }
  };
  return {
    screen: process.platform === 'darwin' ? media('screen') : 'granted',
    camera: media('camera'),
    microphone: media('microphone'),
    accessibility: process.platform === 'darwin' ? (systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied') : 'granted',
  };
}

export async function openPermissionSettings(kind: PermKind): Promise<void> {
  if (process.platform === 'darwin') {
    const pane: Record<PermKind, string> = {
      screen: 'Privacy_ScreenCapture',
      camera: 'Privacy_Camera',
      microphone: 'Privacy_Microphone',
      accessibility: 'Privacy_Accessibility',
    };
    if (kind === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true);
    if (kind === 'camera' || kind === 'microphone') await systemPreferences.askForMediaAccess(kind).catch(() => false);
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane[kind]}`);
    return;
  }
  const uri: Partial<Record<PermKind, string>> = { camera: 'ms-settings:privacy-webcam', microphone: 'ms-settings:privacy-microphone' };
  if (uri[kind]) await shell.openExternal(uri[kind]);
}