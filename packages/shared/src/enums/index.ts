export enum ElementType {
  VIDEO = 'video',
  IMAGE = 'image',
  MODEL = 'model',
  SOUND = 'sound',
  NFT = 'nft',
  WIDGET = 'widget',
  CLAIM_POINT = 'claim_point',
  AD_SPACE = 'ad_space',
}

export enum ClickEventType {
  NONE = 0,
  EXTERNAL = 1,
  SOUND = 2,
  STREAM = 3,
  MOVE = 4,
  TELEPORT = 5,
}

export enum WidgetControlType {
  NONE = 0,
  TOGGLE = 1,
  TEXT = 2,
  SELECTOR = 3,
  DATETIME = 4,
  TRIGGER = 5,
  SLIDER = 6,
}

export enum VideoSourceType {
  NONE = 0,
  IMAGE = 1,
  PLAYLIST = 2,
  LIVE = 3,
  ADS = 4,
  PLAYLIST_ADS = 5,
  /** Scheduled showings at set times, the same moment for everyone (LIV-87). */
  SCHEDULED = 6,
}

export enum SoundSourceType {
  CLIP = 0,
  LOOP = 1,
  PLAYLIST = 2,
  STREAM = 3,
}

export enum SceneSettingType {
  LOCALIZATION = 0,
  MODERATION = 1,
  INTEROPERABILITY = 2,
  ACCESS = 3,
}

export enum UserRole {
  BASIC = 0,
  EARLY_ACCESS = 1,
  ADVANCED = 2,
  SCENE_ADMIN = 3,
  ORG_ADMIN = 4,
  VIRVI_CONTRACTOR = 5,
  VIRVI_EMPLOYEE = 6,
  VIRVI_ADMIN = 7,
  GOD_MODE = 10,
}

export enum AnalyticsSessionRole {
  VISITOR = 0,
  SCENE_ADMIN = 1,
  ORG_ADMIN = 2,
  VIRVI_CONTRACTOR = 3,
  VIRVI_EMPLOYEE = 4,
  VIRVI_ADMIN = 5,
}

export enum AnalyticsSegmentType {
  LOADING = 'loading',
  IDLE = 'idle',
  STATIONARY_DISENGAGED = 'stationary_disengaged',
  STATIONARY_ENGAGED = 'stationary_engaged',
  RUNNING_DISENGAGED = 'running_disengaged',
  WALKING_DISENGAGED = 'walking_disengaged',
  RUNNING_ENGAGED = 'running_engaged',
  WALKING_ENGAGED = 'walking_engaged',
}

export enum ClaimPointType {
  MARKETPLACE_IMAGE = 0,
  CUSTOM_IMAGE = 1,
  MODEL = 2,
  MANNEQUIN = 3,
}

export enum MannequinType {
  MALE = 0,
  FEMALE = 1,
  MATCH_PLAYER = 2,
}

export enum HUDPanelType {
  ASSET_BROWSER = 'asset_browser',
  SCENE_LAYOUT = 'scene_layout',
  EVENT_CONTROL = 'event_control',
  STREAM_CONTROL = 'stream_control',
  WORLD_STATUS = 'world_status',
  NOTIFICATIONS = 'notifications',
  UPGRADE = 'upgrade',
  ROLES = 'roles',
  RAFFLE = 'raffle',
}
