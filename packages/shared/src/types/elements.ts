import {
  ElementType,
  ClickEventType,
  VideoSourceType,
  SoundSourceType,
  WidgetControlType,
  ClaimPointType,
  MannequinType,
} from '../enums/index.js';
import { Vec3, ClickEvent } from './math.js';
import type { AdShape, AdFormats } from '../ads.js';
import type { FrameSettings } from '../frames.js';

// ---------------------------------------------------------------------------
// Generic element types
// ---------------------------------------------------------------------------

export interface SceneElement {
  id: string;
  sceneId: string;
  presetId: string;
  type: ElementType;
  name?: string;
  enabled: boolean;
  customId?: string;
  customRendering: boolean;
  clickEvent?: ClickEvent;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SceneElementInstance {
  id: string;
  elementId: string;
  enabled: boolean;
  customId?: string;
  customRendering: boolean;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  clickEvent?: ClickEvent;
  parent?: string;
  withCollisions: boolean;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Per-element-type property interfaces
// ---------------------------------------------------------------------------

export interface VideoProperties {
  liveSrc?: string;
  isLive?: boolean;
  enableLiveStream?: boolean;
  offImageSrc?: string;
  offType?: VideoSourceType;
  playlist?: string[];
  volume?: number;
  emission?: number;
  adShape?: AdShape; // defaults to '16:9'
  /** A frame around the screen (LIV-129); none when absent. */
  frame?: FrameSettings;
}

export interface ImageProperties {
  textureSrc?: string;
  emission?: number;
  isTransparent?: boolean;
  /** A frame around the picture (LIV-129); none when absent. */
  frame?: FrameSettings;
}

export interface ModelProperties {
  modelSrc?: string;
}

export interface SoundProperties {
  audioSrc?: string;
  volume?: number;
  sourceType?: SoundSourceType;
}

export interface WidgetProperties {
  controlType?: WidgetControlType;
  value?: unknown;
  order?: number;
}

export interface ClaimPointProperties {
  giveawayId?: string;
  claimPointType?: ClaimPointType;
  enableKiosk?: boolean;
  enableSpin?: boolean;
  imgSrc?: string;
  modelSrc?: string;
  mannequinType?: MannequinType;
  hoverText?: string;
  color1?: { r: number; g: number; b: number; a: number };
  color2?: { r: number; g: number; b: number; a: number };
  color3?: { r: number; g: number; b: number; a: number };
  kioskImgSrc?: string;
  itemYOffset?: number;
  itemScale?: number;
}

export interface AdSpaceProperties {
  shape: AdShape;
  formats: AdFormats;
  fallbackImageSrc?: string;
}

export interface NftProperties {
  contractAddress?: string;
  tokenId?: string;
}
