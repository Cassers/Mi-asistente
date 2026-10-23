export interface Profile {
  configured: boolean; name: string; userName: string; address: string; style: string;
  wakeWord: string; speechRate: number; language: string; timeZone: string;
}
export const DEFAULT_PROFILE: Readonly<Profile>;
export function normalizeProfile(raw: unknown): Profile;
export function displayName(profile: Profile): string;
export function wakeWord(profile: Profile): string;
export function wakePattern(profile: Profile, kind?: 'any' | 'bare' | 'leading'): RegExp;
