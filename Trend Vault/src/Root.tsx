import './index.css';
import React from 'react';
import { Composition } from 'remotion';
import { ClipVideo } from './ClipVideo';
import { ZodiacVideo } from './ZodiacVideo';
import type { ZodiacVideoProps } from './ZodiacVideo';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ClipVideoLoose   = ClipVideo   as React.ComponentType<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ZodiacVideoLoose = ZodiacVideo as React.ComponentType<any>;

const defaultZodiacProps: ZodiacVideoProps = {
  backgroundVideo:      'none',
  backgroundBlur:       0,
  backgroundBrightness: 0.8,
  grainIntensity:       30,
  grainType:            'film',
  fogOverlay:           false,
  rainOverlay:          false,
  slowZoom:             true,
  colorGrade:           'dark',
  colorGradeIntensity:  100,
  saturation:           100,
  contrast:             100,
  exposure:             0,
  highlights:           0,
  shadows:              0,
  vignette:             true,
  fontFamily:           'Impact, "Arial Black", sans-serif',
  fontSize:             68,
  textColor:            '#FFFFFF',
  textAnimation:        'fade',
  animSpeed:            1.0,
  zodiacSign:           'Scorpio',
  zodiacSymbol:         '♏',
  scriptLines:          [
    { text: 'This is a preview.', type: 'hook', startFrame: 0, endFrame: 120 },
  ],
  durationInSeconds:    60,
  musicVolume:          0.25,
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ClipVideo"
        component={ClipVideoLoose}
        fps={30}
        width={1080}
        height={1920}
        durationInFrames={1800}
        defaultProps={{
          clipName: 'current-clip.mp4',
          words: [],
          hookText: 'HOOK TEXT HERE',
          title: 'Clip Title',
          durationInSeconds: 60,
        }}
        calculateMetadata={async ({ props }) => ({
          durationInFrames: Math.ceil(Number(props.durationInSeconds ?? 60) * 30),
        })}
      />
      <Composition
        id="ZodiacVideo"
        component={ZodiacVideoLoose}
        fps={30}
        width={1080}
        height={1920}
        durationInFrames={2700}
        defaultProps={defaultZodiacProps}
        // calculateMetadata runs at render time so we can read the user's
        // chosen fps (30 or 60) and the actual voice-driven duration from
        // props. This is what makes 60 fps work end-to-end.
        calculateMetadata={async ({ props }) => {
          const fps = Math.max(15, Math.min(60, Number((props as Record<string, unknown>).fps ?? 30)));
          const dur = Number(props.durationInSeconds ?? 90);
          return {
            fps,
            durationInFrames: Math.ceil(dur * fps),
          };
        }}
      />
    </>
  );
};
