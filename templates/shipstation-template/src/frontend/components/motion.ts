/** sx helper — transitions only when the user has not requested reduced motion. */
export const motionTransition = (properties: string, duration = '0.2s') => ({
  transition: properties,
  '@media (prefers-reduced-motion: reduce)': {
    transition: 'none',
  },
  ...(duration !== '0.2s' ? { transitionDuration: duration } : {}),
});

export const motionFadeIn = {
  opacity: 0,
  animation: 'shipstationFadeIn 0.25s ease forwards',
  '@keyframes shipstationFadeIn': {
    to: { opacity: 1 },
  },
  '@media (prefers-reduced-motion: reduce)': {
    opacity: 1,
    animation: 'none',
  },
} as const;
