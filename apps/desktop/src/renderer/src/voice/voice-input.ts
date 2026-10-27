/** Track which composer text belongs to speech, without erasing later typing or speech. */
export function createVoiceInputTracker() {
  let preview: string | null = null;
  let edited = false;
  let revision = 0;
  return {
    preview(text: string): boolean {
      if (edited) return false;
      preview = text;
      revision++;
      return true;
    },
    edited(): void {
      edited = true;
      preview = null;
      revision++;
    },
    complete(): (current: string) => string {
      const completed = preview;
      const atCompletion = ++revision;
      preview = null;
      edited = false;
      return current => revision === atCompletion && completed !== null && current === completed ? '' : current;
    },
  };
}
