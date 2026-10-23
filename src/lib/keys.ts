import type { KeyboardEvent } from 'react';

/** Enter that should act (submit/add/save). Only a composition still in progress blocks it:
 * keyCode 229 alone is also what Safari, iOS predictive text and some layouts send for a plain Enter. */
export function isActionEnter(e: KeyboardEvent<HTMLElement>): boolean {
  return e.key === 'Enter' && !e.nativeEvent.isComposing;
}

/** Attributes that keep password managers (1Password, LastPass, Bitwarden) off small app fields. */
export const NO_AUTOFILL = {
  autoComplete: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;
