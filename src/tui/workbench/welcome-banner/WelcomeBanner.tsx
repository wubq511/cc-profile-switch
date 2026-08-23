import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';

import {
  renderWelcomeBanner,
  renderWelcomeBannerFrame,
  resolveBannerOptions,
  welcomeBannerSweepColumn,
  type BannerOptions,
} from './render';
import { getBannerArt } from './art';

type Tick = (callback: () => void, ms: number) => () => void;

const defaultTick: Tick = (callback, ms) => {
  const id = setInterval(callback, ms);
  return () => clearInterval(id);
};

type WelcomeBannerProps = {
  columns: number;
  platform?: string;
  env?: NodeJS.ProcessEnv;
  tick?: Tick;
  configEnabled: boolean;
};

/** Welcome banner wordmark with a one-shot highlight sweep.
 *
 * The Workbench's WelcomeCard already dismisses on any key, which satisfies the
 * "any key skips animation" requirement; no separate key handling is added
 * here.
 */
export function WelcomeBanner({
  columns,
  platform = process.platform,
  env = process.env,
  tick = defaultTick,
  configEnabled,
}: WelcomeBannerProps): React.ReactElement | null {
  const options = resolveBannerOptions({
    isTTY: true,
    columns,
    platform,
    env,
    chalkLevel: chalk.level,
    configEnabled,
  });

  if (options === null) return null;

  if (options.widthTier === 'plain') {
    const banner = renderWelcomeBanner(options);
    return renderBannerLines(banner);
  }

  return React.createElement(AnimatedBanner, { options, tick });
}

/** One-shot sweep: 12 frames at 90ms ≈ 1.1s, then the static banner stays.
 *  The window width is computed in render.ts; the path runs from off-screen
 *  left to off-screen right so the grain front crosses the whole wordmark. */
const FRAME_COUNT = 12;
const SWEEP_INTERVAL_MS = 90;

function AnimatedBanner({
  options,
  tick,
}: {
  options: BannerOptions;
  tick: Tick;
}): React.ReactElement {
  const art = getBannerArt(options.widthTier, options.charset);
  const [frame, setFrame] = useState(0);

  // Frame FRAME_COUNT (sweep past the end) renders the static banner and the
  // effect below then schedules no further interval.
  useEffect(() => {
    if (frame >= FRAME_COUNT) return undefined;
    const cancel = tick(() => setFrame((f) => f + 1), SWEEP_INTERVAL_MS);
    return cancel;
  }, [frame, tick]);

  const banner =
    frame >= FRAME_COUNT
      ? renderWelcomeBanner(options)
      : renderWelcomeBannerFrame(
          options,
          welcomeBannerSweepColumn(art.tierWidth, frame, FRAME_COUNT),
        );

  return renderBannerLines(banner);
}

function renderBannerLines(banner: string): React.ReactElement {
  const lines = banner.split('\n');
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    ...lines.map((line, index) => React.createElement(Text, { key: index }, line)),
  );
}
