/** `music-mode` namespace dictionaries (view tab label + theater strings). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'music-mode'

/** The music-mode dictionary key set (the source of truth for both locales). */
export type MusicModeKey =
  | 'view.music'
  | 'stage.brand'
  | 'stage.subtitle'
  | 'stage.note'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The music-mode view tab label and theater stage copy. */
    'music-mode': MusicModeKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<MusicModeKey, string> = {
  'view.music': '音乐',
  'stage.brand': 'REGRET · MUSIC MODE',
  'stage.subtitle': '音乐模式 · 实验舞台',
  'stage.note': '对话内容区舞台 · 输入框在下方待命',
}

/** English dictionary. */
export const en: Record<MusicModeKey, string> = {
  'view.music': 'Music',
  'stage.brand': 'REGRET · MUSIC MODE',
  'stage.subtitle': 'Music mode · experiment stage',
  'stage.note': 'Stage inside the conversation area · composer ready below',
}
