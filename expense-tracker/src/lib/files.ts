import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/**
 * Hands a text file to the person: a download in the browser, the share sheet
 * in the Android app (its web view can't download), from where it can go to
 * Files, Drive, email or a chat.
 */
export async function saveTextFile(name: string, content: string, mime: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.writeFile({ path: name, data: content, directory: Directory.Cache, encoding: Encoding.UTF8 });
    try {
      await Share.share({ title: name, files: [uri], dialogTitle: `Save or send ${name}` });
    } catch (error) {
      // Closing the share sheet rejects; that's a choice, not a failure.
      if (!/cancel/i.test(String((error as Error)?.message ?? error))) throw error;
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
