import type { WebpackConfiguration } from '@remotion/bundler';
/**
 * @description A function that modifies the default Webpack configuration to make the necessary changes to support Tailwind.
 * @see [Documentation](https://www.remotion.dev/docs/tailwind-v4/enable-tailwind)
 */
export declare const enableTailwind: (currentConfiguration: WebpackConfiguration) => WebpackConfiguration;
