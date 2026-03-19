import React from "react";
import { Composition } from "remotion";
import type { AnyZodObject } from "zod";
import { CaptionOverlay } from "./CaptionOverlay";
import type { CaptionOverlayProps } from "./types";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition<AnyZodObject, CaptionOverlayProps>
      id="CaptionOverlay"
      component={CaptionOverlay}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={1}
      defaultProps={{
        groups: [],
        width: 1080,
        height: 1920,
        fps: 30,
        durationInFrames: 1,
      }}
      calculateMetadata={async ({ props }) => ({
        durationInFrames: props.durationInFrames,
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
    />
  );
};
