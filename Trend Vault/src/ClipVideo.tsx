import React from 'react';
import { AbsoluteFill, Video, useCurrentFrame, useVideoConfig, staticFile } from 'remotion';

interface Word {
  text: string;
  start: number; // ms from clip start
  end: number;   // ms from clip start
}

interface ClipVideoProps {
  clipName: string;
  words: Word[];
  hookText: string;
  title: string;
  durationInSeconds: number;
}

const WORDS_PER_GROUP = 5;

function buildGroups(words: Word[]): Word[][] {
  const groups: Word[][] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_GROUP) {
    groups.push(words.slice(i, i + WORDS_PER_GROUP));
  }
  return groups;
}

function getActiveGroup(groups: Word[][], currentMs: number): Word[] | null {
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const groupStart = group[0].start;
    const nextGroupStart = groups[i + 1]?.[0]?.start ?? Infinity;
    if (currentMs >= groupStart && currentMs < nextGroupStart) {
      return group;
    }
  }
  // After last group — keep showing last group
  if (groups.length > 0) {
    const last = groups[groups.length - 1];
    if (currentMs >= last[0].start) return last;
  }
  return null;
}

export const ClipVideo: React.FC<ClipVideoProps> = ({
  clipName,
  words,
  hookText,
  title,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;

  const groups = buildGroups(words);
  const activeGroup = getActiveGroup(groups, currentMs);

  const src = staticFile(clipName);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000', overflow: 'hidden' }}>
      {/* Blurred background — fills entire frame */}
      <Video
        src={src}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          filter: 'blur(28px) brightness(0.28)',
          transform: 'scale(1.15)',
        }}
      />

      {/* Main video — centered, full width, letterboxed */}
      <AbsoluteFill
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Video
          src={src}
          style={{
            width: '100%',
            height: 'auto',
            maxHeight: '62%',
          }}
        />
      </AbsoluteFill>

      {/* Hook text at the top */}
      <div
        style={{
          position: 'absolute',
          top: 72,
          left: 48,
          right: 48,
          textAlign: 'center',
          fontFamily: '"Arial Black", "Arial Bold", Impact, sans-serif',
          fontSize: 52,
          fontWeight: 900,
          color: '#FFE500',
          textTransform: 'uppercase',
          letterSpacing: 3,
          lineHeight: 1.15,
          textShadow:
            '3px 3px 0 #000, -3px -3px 0 #000, 3px -3px 0 #000, -3px 3px 0 #000, 0 4px 12px rgba(0,0,0,0.9)',
        }}
      >
        {hookText}
      </div>

      {/* Clip number badge */}
      <div
        style={{
          position: 'absolute',
          top: 48,
          right: 48,
          backgroundColor: 'rgba(0,0,0,0.55)',
          borderRadius: 10,
          padding: '6px 18px',
          fontFamily: 'Arial, sans-serif',
          fontSize: 22,
          color: 'rgba(255,255,255,0.85)',
          fontWeight: 700,
        }}
      >
        {title}
      </div>

      {/* Caption area */}
      {activeGroup && (
        <div
          style={{
            position: 'absolute',
            bottom: 110,
            left: 40,
            right: 40,
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            alignItems: 'flex-end',
            gap: '6px 14px',
          }}
        >
          {activeGroup.map((word, i) => {
            const isActive = currentMs >= word.start && currentMs <= word.end;
            return (
              <span
                key={i}
                style={{
                  fontFamily: '"Arial Black", "Arial Bold", Impact, sans-serif',
                  fontSize: 76,
                  fontWeight: 900,
                  textTransform: 'uppercase',
                  lineHeight: 1.05,
                  color: isActive ? '#FFE500' : '#FFFFFF',
                  textShadow: isActive
                    ? '4px 4px 0 #000, -4px -4px 0 #000, 4px -4px 0 #000, -4px 4px 0 #000, 0 6px 20px rgba(0,0,0,1)'
                    : '3px 3px 0 #000, -3px -3px 0 #000, 3px -3px 0 #000, -3px 3px 0 #000, 0 4px 14px rgba(0,0,0,0.95)',
                }}
              >
                {word.text}
              </span>
            );
          })}
        </div>
      )}

      {/* Bottom gradient for caption readability */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 280,
          background:
            'linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0) 100%)',
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
};
