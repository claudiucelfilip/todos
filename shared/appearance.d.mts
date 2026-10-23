export interface StudioTheme { id: string; name: string; canvas: string; header: string; card: string; editor: string; accent: string; ink: string; }
export interface StudioPattern { id: string; name: string; mask: string; size: string; }
export const studioThemes: StudioTheme[];
export const studioPatterns: StudioPattern[];
export const legacyThemeIds: Record<string, string>;
export function resolveStudioTheme(id?: string): StudioTheme;
