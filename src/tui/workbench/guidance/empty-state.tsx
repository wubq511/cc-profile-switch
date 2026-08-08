// Recipe-style empty states (issue #76 §5): 2–3 line recipes with the concrete
// next step — never bare "nothing here". Copy wraps rather than truncates so it
// stays readable in the narrowest sidebar (~26 cols).

import React from 'react';
import { Box, Text } from 'ink';

import { useI18n } from '../i18n/react';

type RecipeEmptyStateProps = {
  title: string;
  recipe: string;
  action: string;
  /** The no-match title embeds the query and can exceed one line. */
  titleWrap?: boolean;
};

/** title + recipe + one concrete next step. */
function RecipeEmptyState({
  title,
  recipe,
  action,
  titleWrap,
}: RecipeEmptyStateProps): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { bold: true, wrap: titleWrap ? 'wrap' : undefined }, title),
    React.createElement(Text, { dimColor: true, wrap: 'wrap' }, recipe),
    React.createElement(Text, { color: 'green' }, action),
  );
}

/** Zero-Profile state: what a Profile is + the [n] create offer. */
export function ZeroProfilesEmptyState(): React.ReactElement {
  const { t } = useI18n();

  return React.createElement(RecipeEmptyState, {
    title: t('empty.noProfiles.title'),
    recipe: t('empty.noProfiles.recipe'),
    action: t('empty.noProfiles.create'),
  });
}

/** No-match search state: what search covers + how to clear. */
export function NoMatchEmptyState({ query }: { query: string }): React.ReactElement {
  const { t } = useI18n();

  return React.createElement(RecipeEmptyState, {
    titleWrap: true,
    title: t('empty.noMatch.title', { query }),
    recipe: t('empty.noMatch.recipe'),
    action: t('empty.noMatch.clear'),
  });
}
